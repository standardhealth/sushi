import sanitize from 'sanitize-filename';
import { cloneDeep, difference } from 'lodash';
import { orderedCloneDeep } from './common';
import { Meta } from './specialTypes';
import { HasId } from './mixins';
import { applyMixins } from '../utils/Mixin';
import { InstanceUsage } from '../fshtypes/InstanceUsage';

/**
 * A class representing a FHIR Instance.
 *
 * The defined properties on InstanceDefinition are relatively simple due to the fact that each FHIR resource will
 * be setting different properties based on their own definitions.
 */
export class InstanceDefinition {
  _instanceMeta: InstanceMeta = {};
  resourceType: string;
  // id?: FHIRId; // provided by HasId mixin
  meta?: Meta;
  [key: string]: any; // Allow any key value pair on InstanceDefinition due to the high number of potential properties that can be set on a FHIR instance

  /**
   * Get the file name for serializing to disk.
   * @returns {string} the filename
   */
  getFileName(): string {
    // Logical instances should use Binary type. See: https://fshschool.org/docs/sushi/tips/#instances-of-logical-models
    const type = this._instanceMeta.sdKind === 'logical' ? 'Binary' : this.resourceType;
    const versionString = this._instanceMeta.versionId ? `_v${this._instanceMeta.versionId}` : '';
    const filename = `${type}-${this.id ?? this._instanceMeta.name}${versionString}.json`;
    return sanitize(filename, {
      replacement: '-'
    });
  }

  toJSON(): any {
    const orderedKeys = ['resourceType', '_resourceType', 'id', '_id', 'meta', '_meta'].filter(
      key => this[key] != null
    );
    // _instanceMeta is only needed for lookup and IG config - not a FHIR property
    const additionalKeys = difference(Object.keys(this), [...orderedKeys, '_instanceMeta']);
    return orderedCloneDeep(this, [...orderedKeys, ...additionalKeys]);
  }

  static fromJSON(json: { [key: string]: any }): InstanceDefinition {
    json = cloneDeep(json);
    const instanceDefinition = new InstanceDefinition();
    Object.keys(json).forEach(key => {
      instanceDefinition[key] = json[key];
    });
    // Default the meta name to the id
    if (json.id != null) {
      instanceDefinition._instanceMeta.name = json.id;
    }
    return instanceDefinition;
  }
}

type InstanceMeta = {
  name?: string;
  title?: string;
  description?: string;
  usage?: InstanceUsage;
  sdType?: string;
  sdKind?: string;
  instanceOfUrl?: string;
  versionId?: string;
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface InstanceDefinition extends HasId {}
applyMixins(InstanceDefinition, [HasId]);
