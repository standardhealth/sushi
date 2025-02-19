import { isEqual, uniqWith } from 'lodash';
import { Fishable, Type, Metadata } from './Fishable';
import { FSHTank } from '../import';
import { FHIRDefinitions } from '../fhirdefs';
import { Package } from '../export';
import { logger } from './FSHLogger';
import { Instance } from '../fshtypes';

/**
 * The MasterFisher can fish from the tank, the FHIR definitions, and the package that is currently
 * being exported. When the MasterFisher fishes, it fishes in the package first, then the tank, and
 * then the FHIRDefinitions.  This essentially prefers local definitions first (when there are naming
 * clashes).
 *
 * The MasterFisher also uses its knowledge of these Fishable locations to do some necessary magic.
 * For instance, the FSHTank has no knowledge of FHIRDefinitions, so it cannot provide the correct
 * sdType for its metadata results.  When the MasterFisher detects this has happened, it uses the
 * other Fishable locations to determine the proper sdType (even for an item that currently exists
 * only in the tank).
 */
export class MasterFisher implements Fishable {
  public defaultFHIRVersion?: string;
  constructor(
    public tank?: FSHTank,
    public fhir?: FHIRDefinitions,
    public pkg?: Package
  ) {
    this.defaultFHIRVersion =
      fhir?.fishForFHIR('StructureDefinition')?.fhirVersion ?? tank?.config.fhirVersion?.[0];
  }

  /**
   * Searches for the FHIR JSON by name/id/url.  It will first search through the local package
   * (which contains FHIR artifacts exported so far), then through the external FHIR definitions.
   * @param {string} item - the item name/id/url to fish for
   * @param types - the allowable types to fish for
   */
  fishForFHIR(item: string, ...types: Type[]): any | undefined {
    // Resolve the alias if necessary
    item = this.tank?.resolveAlias(item) ?? item;

    let result = this.fhir.fishForPredefinedResource(item, ...types);
    if (result != null) return result;

    // First check for it in the package
    result = this.pkg?.fishForFHIR(item, ...types);
    if (result == null) {
      // If it is in the tank, return undefined. We don't want to return the external FHIR
      // definition, even if it exists -- because it won't match what is in the tank.  This
      // ensures consistency between the outputs of fishForFHIR and fishForMetadata.
      if (this.tank?.fish(item, ...types)) {
        return;
      }
      result = this.fhir?.fishForFHIR(item, ...types);
    }
    return result;
  }

  /**
   * Searches for the Metadata associated with the passed in name/id/url.  It will first search
   * through the local package (which contains FHIR artifacts exported so far), then through the
   * tank, then through the external FHIR definitions. This function is useful because it gets
   * commonly used information without having to force an export. This helps to reduce the risk
   * of circular dependencies causing problems.
   * @param item - the item/name/id url to fish for
   * @param types - the allowable types to fish for
   */
  fishForMetadata(item: string, ...types: Type[]): Metadata {
    // Resolve the alias if necessary
    item = this.tank?.resolveAlias(item) ?? item;

    let result = this.fhir.fishForPredefinedResourceMetadata(item, ...types);
    if (result != null) return result;

    const fishables: Fishable[] = [this.pkg, this.tank, this.fhir].filter(f => f != null);
    for (const fishable of fishables) {
      result = fishable.fishForMetadata(item, ...types);
      if (result != null) {
        return this.fixMetadata(result, item, types, fishable, fishables);
      }
    }
  }

  /**
   * Searches for the Metadatas associated with the passed in name/id/url.  It will first search
   * through the local package (which contains FHIR artifacts exported so far), then through the
   * tank, then through the external FHIR definitions. This function is useful because it gets
   * commonly used information without having to force an export. This helps to reduce the risk
   * of circular dependencies causing problems.
   * @param item - the item/name/id url to fish for
   * @param types - the allowable types to fish for
   */
  fishForMetadatas(item: string, ...types: Type[]): Metadata[] {
    // Resolve the alias if necessary
    item = this.tank?.resolveAlias(item) ?? item;

    const metadatas = this.fhir.fishForPredefinedResourceMetadatas(item, ...types);

    const fishables: Fishable[] = [this.pkg, this.tank, this.fhir].filter(f => f != null);
    for (const fishable of fishables) {
      const results = fishable
        .fishForMetadatas(item, ...types)
        .map(result => this.fixMetadata(result, item, types, fishable, fishables));
      metadatas.push(...results);
    }
    // It's possible to get duplicates for predefined resource or resources in package and tank, do de-dupe them
    return uniqWith(metadatas, isEqual);
  }

  private fixMetadata(
    metadata: Metadata,
    item: string,
    types: Type[],
    fishable: Fishable,
    fishables: Fishable[]
  ) {
    if (metadata) {
      if (fishable instanceof FSHTank) {
        // If it came from the tank, we need to get the sdType because the tank doesn't know.
        metadata.sdType = this.findSdType(metadata, types, fishables);
        // When an Instance comes from the FSHTank, the FSHTank doesn't know its resourceType,
        // only its InstanceOf. But here we have access to the other fishers, so we can try
        // to figure that resourceType out here
        if (!metadata.resourceType) {
          const fshDefinition = fishable
            .fishAll(item, ...types)
            .find(e => e.id == metadata.id && e.name == metadata.name);
          if (fshDefinition instanceof Instance) {
            metadata.resourceType = this.fishForMetadata(fshDefinition.instanceOf)?.sdType;
          }
        }
      }
      // Add url to metadata for non-inline Instances
      if (!metadata.url && metadata.instanceUsage !== 'Inline') {
        metadata.url = `${this.pkg.config.canonical}/${metadata.resourceType}/${metadata.id}`;
      }
      return metadata;
    }
  }

  private findSdType(meta: Metadata, types: Type[], fishables: Fishable[]): string | undefined {
    const history = [meta];
    let [sdType, parent] = [meta.sdType, meta.parent];
    while (sdType == null && parent != null) {
      // Resolve the alias if necessary
      parent = this.tank?.resolveAlias(parent) ?? parent;

      let parentResult: Metadata;
      for (const fishable of fishables) {
        parentResult = fishable.fishForMetadata(parent, ...types);
        if (parentResult != null) {
          if (history.some(md => md.url === parentResult.url)) {
            let message =
              'Circular dependency detected on parent relationships: ' +
              [...history, parentResult].map(l => l.name).join(' < ');
            const fhirMeta =
              this.fhir?.fishForMetadata(parentResult.name) ??
              this.fhir?.fishForMetadata(parentResult.id);
            if (fhirMeta) {
              message += `\n  If the parent ${parentResult.name} is intended to refer to the FHIR resource, use its URL: ${fhirMeta.url}`;
            }
            logger.error(
              message,
              fishable instanceof FSHTank ? fishable.fish(parent)?.sourceInfo : undefined
            );
            return;
          }
          history.push(parentResult);
          break; // break out of fishables loop
        }
      }
      [sdType, parent] = [parentResult?.sdType, parentResult?.parent];
    }
    return sdType;
  }
}
