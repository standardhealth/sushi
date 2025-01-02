import {
  cloneDeep,
  differenceWith,
  flatten,
  intersectionWith,
  isEmpty,
  isEqual,
  isMatch,
  uniqWith,
  upperFirst
} from 'lodash';
import { minify } from 'html-minifier-terser';
import { isUri } from 'valid-url';
import { PathPart, StructureDefinition } from './StructureDefinition';
import {
  CodeableConcept,
  CodeableReference,
  Coding,
  Element,
  Quantity,
  Ratio,
  Reference
} from './dataTypes';
import {
  FshCanonical,
  FshCode,
  FshRatio,
  FshQuantity,
  FshReference,
  Invariant,
  SourceInfo
} from '../fshtypes';
import { AddElementRule, AssignmentValueType, OnlyRule, OnlyRuleType } from '../fshtypes/rules';
import {
  BindingStrengthError,
  CodedTypeNotFoundError,
  DuplicateSliceError,
  FixedToPatternError,
  InvalidCanonicalUrlError,
  InvalidCardinalityError,
  InvalidFHIRIdError,
  InvalidMappingError,
  InvalidMustSupportError,
  InvalidSumOfSliceMinsError,
  InvalidTypeError,
  InvalidUriError,
  MismatchedTypeError,
  MultipleStandardsStatusError,
  NarrowingRootCardinalityError,
  NonAbstractParentOfSpecializationError,
  NoSingleTypeError,
  SliceTypeRemovalError,
  SlicingDefinitionError,
  SlicingNotDefinedError,
  TypeNotFoundError,
  ValueAlreadyAssignedError,
  ValueConflictsWithClosedSlicingError,
  ConstrainingCardinalityError,
  InvalidChoiceTypeRulePathError,
  CannotResolvePathError,
  MismatchedBindingTypeError,
  ValidationError
} from '../errors';
import { typeString } from '../fshtypes/common';
import {
  setPropertyOnDefinitionInstance,
  splitOnPathPeriods,
  isReferenceType,
  isModifierExtension,
  getArrayIndex
} from './common';
import {
  Fishable,
  Type,
  Metadata,
  logger,
  fishForMetadataBestVersion,
  fishForFHIRBestVersion
} from '../utils';
import { InstanceDefinition } from './InstanceDefinition';
import { idRegex } from './primitiveTypes';
import sax from 'sax';

const PROFILE_ELEMENT_EXTENSION =
  'http://hl7.org/fhir/StructureDefinition/elementdefinition-profile-element';

export class ElementDefinitionType {
  private _actualCode: string;
  _code?: Element;
  profile?: string[];
  _profile?: Element[];
  targetProfile?: string[];
  _targetProfile?: Element[];
  aggregation?: string[];
  _aggregation?: Element[];
  versioning?: string;
  _versioning?: Element;
  extension?: ElementDefinitionExtension[];

  constructor(code: string) {
    this._actualCode = code;
  }

  /**
   * Element.id, Extension.url, and primitive types are specified in the valueUrl of an extension.
   * This function returns the fhir-type extension's valueUrl if available, else returns the code.
   * @see {@link http://hl7.org/fhir/extension-structuredefinition-fhir-type.html}
   */
  get code(): string {
    const fhirTypeExtension = this.extension?.find(
      ext => ext.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type'
    );
    // R4 uses valueUrl; R5 uses valueUri
    return fhirTypeExtension?.valueUrl ?? fhirTypeExtension?.valueUri ?? this._actualCode;
  }

  set code(c: string) {
    this._actualCode = c;
  }

  getActualCode(): string {
    return this._actualCode;
  }

  withProfiles(...profiles: string[]): this {
    this.profile = profiles;
    return this;
  }

  withTargetProfiles(...targetProfiles: string[]): this {
    this.targetProfile = targetProfiles;
    return this;
  }

  toJSON(): ElementDefinitionTypeJSON {
    // Remove the _code key specific to ElementDefinitionType
    const elDefTypeClone = cloneDeep(this);
    delete elDefTypeClone._actualCode;

    // Create ElementDefinitionTypeJSON with a code and any properties present on the ElementDefinitionType
    const elDefTypeJSON: ElementDefinitionTypeJSON = {
      code: this.getActualCode(),
      ...elDefTypeClone
    };
    return elDefTypeJSON;
  }

  static fromJSON(json: any): ElementDefinitionType {
    json = cloneDeep(json);
    const elDefType = new ElementDefinitionType(json.code);

    // TODO: other fromJSON methods check properties for undefined.
    // investigate the implications of this change on materializing implied extensions.
    if (json._code) {
      elDefType._code = json._code;
    }
    elDefType.profile = json.profile;
    if (json._profile) {
      elDefType._profile = json._profile;
    }
    elDefType.targetProfile = json.targetProfile;
    if (json._targetProfile) {
      elDefType._targetProfile = json._targetProfile;
    }
    elDefType.aggregation = json.aggregation;
    if (json._aggregation) {
      elDefType._aggregation = json._aggregation;
    }
    elDefType.versioning = json.versioning;
    if (json._versioning) {
      elDefType._versioning = json._versioning;
    }
    elDefType.extension = json.extension;

    return elDefType;
  }
}

/**
 * A class representing a FHIR R4 ElementDefinition.  For the most part, each allowable property in an ElementDefinition
 * is represented via a get/set in this class, and the value is expected to be the FHIR-compliant JSON that would go
 * in the StructureDefinition JSON file (w/ translation for R3).
 * @see {@link http://hl7.org/fhir/R4/elementdefinition.html}
 */
export class ElementDefinition {
  private _privateId: string;
  path: string;
  extension: any[];
  modifierExtension: any[];
  representation: string[];
  sliceName: string;
  sliceIsConstraining: boolean;
  label: string;
  code: Coding[];
  slicing: ElementDefinitionSlicing;
  short: string;
  definition: string;
  comment: string;
  requirements: string;
  alias: string[];
  min: number;
  max: string;
  base: ElementDefinitionBase;
  contentReference: string;
  type: ElementDefinitionType[];
  meaningWhenMissing: string;
  // defaultValue[x] can be literally almost any field name (e.g., defaultValueCode, etc.),
  // so we can't easily use a getter/setter.  It will be just an unspecified property.  For now.
  orderMeaning: string;
  // fixed[x] can be literally almost any field name (e.g., fixedCode, fixedFoo, etc.).
  // pattern[x] can be literally almost any field name (e.g., patternCoding, patternFoo, etc.).
  // We'll define the ones we are using, but leave the others as unspecified properties.  For now.
  fixedCode: string;
  patternCode: string;
  fixedString: string;
  patternString: string;
  fixedUri: string;
  patternUri: string;
  fixedUrl: string;
  patternUrl: string;
  fixedCanonical: string;
  patternCanonical: string;
  fixedInstant: string;
  patternInstant: string;
  fixedBase64Binary: string;
  patternBase64Binary: string;
  fixedDate: string;
  patternDate: string;
  fixedDateTime: string;
  patternDateTime: string;
  fixedTime: string;
  patternTime: string;
  fixedOid: string;
  patternOid: string;
  fixedId: string;
  patternId: string;
  fixedMarkdown: string;
  patternMarkdown: string;
  fixedUuid: string;
  patternUuid: string;
  fixedXhtml: string;
  patternXhtml: string;
  fixedBoolean: boolean;
  patternBoolean: boolean;
  fixedDecimal: number;
  patternDecimal: number;
  fixedInteger: number;
  patternInteger: number;
  fixedInteger64: string;
  patternInteger64: string;
  fixedUnsignedInt: number;
  patternUnsignedInt: number;
  fixedPositiveInt: number;
  patternPositiveInt: number;
  fixedCodeableConcept: CodeableConcept;
  patternCodeableConcept: CodeableConcept;
  fixedCoding: Coding;
  patternCoding: Coding;
  fixedQuantity: Quantity;
  patternQuantity: Quantity;
  fixedAge: Quantity;
  patternAge: Quantity;
  fixedAddress: InstanceDefinition;
  patternAddress: InstanceDefinition;
  fixedPeriod: InstanceDefinition;
  patternPeriod: InstanceDefinition;
  fixedRatio: Ratio;
  patternRatio: Ratio;
  fixedReference: Reference;
  patternReference: Reference;
  fixedCodeableReference: CodeableReference;
  patternCodeableReference: CodeableReference;
  example: ElementDefinitionExample[];
  // minValue[x] can be many different field names (e.g., minValueDate, minValueQuantity, etc.),
  // so we can't easily use a getter/setter.  It will be just an unspecified property.  For now.
  // maxValue[x] can be many different field names (e.g., maxValueDate, maxValueQuantity, etc.),
  // so we can't easily use a getter/setter.  It will be just an unspecified property.  For now.
  maxLength: number;
  condition: string[];
  constraint: ElementDefinitionConstraint[];
  mustSupport: boolean;
  isModifier: boolean;
  isModifierReason: string;
  isSummary: boolean;
  binding: ElementDefinitionBinding;
  mapping: ElementDefinitionMapping[];
  structDef: StructureDefinition;
  treeParent: ElementDefinition;
  treeChildren: ElementDefinition[];
  private _original: ElementDefinition;
  private _edStructureDefinition: StructureDefinition;
  private _replacementProps: string[][];

  /**
   * Constructs a new ElementDefinition with the given ID.
   * @param {string} id - the ID of the ElementDefinition
   */
  constructor(id = '') {
    this.id = id;
    this._replacementProps = cloneDeep(REPLACEMENT_PROPS);
  }

  get id(): string {
    return this._privateId;
  }

  /**
   * Sets the id of the ElementDefinition and updates the path accordingly.
   * NOTE: This does not automatically update child ids/paths.  That is currently up to the library user.
   * @param {string} id - the ElementDefinition id
   */
  set id(id: string) {
    this._privateId = id;
    // After setting the id, we should re-set the path, which is based on the id but with all
    // slice names removed (e.g., Observation.component:abc.code --> Observation.component.code)
    this.path = this._privateId.replace(/(\.[^.:]+):[^.]+/g, '$1');
  }

  validate(): ValidationError[] {
    const errors: ValidationError[] = [];
    if (this.slicing) {
      if (this.sliceName) {
        errors.push(
          new ValidationError(
            'An element with a slice name should not define its own slicing. Instead, append additional discriminators to the original slicing on the base element.',
            '',
            'warn'
          )
        );
      }
      errors.push(...this.validateSlicing(this.slicing));
    }
    return errors;
  }

  private validateRequired(value: AssignmentValueType, fshPath: string): ValidationError {
    if (!value) {
      return new ValidationError('Missing required value', fshPath);
    }
    return null;
  }

  private validateIncludes(
    value: string,
    allowedValues: string[],
    fshPath: string
  ): ValidationError {
    if (value && !allowedValues.includes(value)) {
      return new ValidationError(
        `Invalid value: #${value}. Value must be selected from one of the following: ${allowedValues
          .map(v => `#${v}`)
          .join(', ')}`,
        fshPath
      );
    }
    return null;
  }

  isArrayOrChoice(): boolean {
    return (
      this.max === '*' ||
      parseInt(this.max) > 1 ||
      this.base.max === '*' ||
      parseInt(this.base.max) > 1 ||
      this.id.endsWith('[x]')
    );
  }

  isPrimitive(fisher: Fishable): boolean {
    if (this.type == null && this.contentReference != null) {
      const referencedElement = this.structDef.findElement(this.getContentReferenceId());
      if (referencedElement?.type?.length === 1) {
        const typeSD = fisher.fishForFHIR(referencedElement.type[0].code, Type.Type);
        return typeSD?.kind === 'primitive-type';
      }
    }
    if (this.type?.length === 1) {
      const typeSD = fisher.fishForFHIR(this.type[0].code, Type.Type);
      return typeSD?.kind === 'primitive-type';
    }
    return false;
  }

  private validateSlicing(slicing: ElementDefinitionSlicing): ValidationError[] {
    const validationErrors: ValidationError[] = [];
    validationErrors.push(this.validateRequired(slicing.rules, 'slicing.rules'));
    validationErrors.push(
      this.validateIncludes(slicing.rules, ALLOWED_SLICING_RULES, 'slicing.rules')
    );
    const isR4 = this.structDef.fhirVersion.startsWith('4.');
    slicing.discriminator?.forEach((d, i) => {
      const discriminatorPath = `slicing.discriminator[${i}]`;
      validationErrors.push(this.validateRequired(d.type, `${discriminatorPath}.type`));
      if (isR4) {
        validationErrors.push(
          this.validateIncludes(d.type, ALLOWED_DISCRIMINATOR_TYPES, `${discriminatorPath}.type`)
        );
      } else {
        validationErrors.push(
          this.validateIncludes(d.type, ALLOWED_DISCRIMINATOR_TYPES_R5, `${discriminatorPath}.type`)
        );
        if (d.type === 'position' && slicing.ordered !== true) {
          validationErrors.push(
            new ValidationError(
              'Slicing ordering must be true when a position discriminator is used.',
              'slicing.ordered'
            )
          );
        }
      }
      validationErrors.push(this.validateRequired(d.path, `${discriminatorPath}.path`));
    });
    return validationErrors.filter(e => e);
  }

  getPathWithoutBase(): string {
    return this.path.slice(this.structDef.pathType.length + 1);
  }

  /**
   * Get the StructureDefinition for ElementDefinition
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @returns {StructureDefinition} the StructureDefinition of ElementDefinition
   */
  getOwnStructureDefinition(fisher: Fishable): StructureDefinition {
    if (this._edStructureDefinition == null) {
      this._edStructureDefinition = StructureDefinition.fromJSON(
        fisher.fishForFHIR('ElementDefinition', Type.Type)
      );
    }
    return this._edStructureDefinition;
  }

  /**
   * Returns the Types that have the given code(s).
   * @param {string[]} codes - the codes to match Types against
   * @returns {ElementDefinitionType[]} the matched Types
   */
  findTypesByCode(...codes: string[]): ElementDefinitionType[] {
    if (!this.type) {
      return [];
    }
    return this.type.filter(t => codes.includes(t.code));
  }

  /**
   * Creates a new element with an id/path indicating it is a child of the current element.
   * Defaults to '$UNKNOWN' if no name is passed in, as it needs a value, but usually a name should be passed in.
   * NOTE: This function does not automatically add the child element to the StructureDefinition.
   * @param {string} name - the name of the child element, to be appended to the parent ID/path
   * @returns {ElementDefinition} the new child element
   */
  newChildElement(name = '$UNKNOWN'): ElementDefinition {
    const el = new ElementDefinition(`${this.id}.${name}`);
    el.structDef = this.structDef;
    return el;
  }

  /**
   * ElementDefinition is capable of producing its own differential, based on differences from a stored "original".
   * This function captures the current state as the "original", so any further changes made would be captured in
   * the generated differential. The structDef reference isn't used in the differential, so it can be removed.
   */
  captureOriginal(): void {
    this._original = this.clone();
    this._original.structDef = undefined;
  }

  /**
   * Clears the stored "original" state, resulting in every property being considered new, and reflected in the
   * generated differential.
   */
  clearOriginal(): void {
    this._original = undefined;
  }

  clearOriginalProperty(pathParts: PathPart[]): void {
    let currentOriginalElement: any = this._original;
    // eslint-disable-next-line
    let currentActualElement: any = this;
    const clearPath = this.calculateClearPath(pathParts);
    for (const [i, pathPart] of clearPath.entries()) {
      if (i < clearPath.length - 1) {
        const key = pathPart.primitive ? `_${pathPart.base}` : pathPart.base;
        currentOriginalElement = currentOriginalElement?.[key];
        currentActualElement = currentActualElement?.[key];
        const currentIndex = getArrayIndex(pathPart);
        if (currentIndex != null) {
          if (Array.isArray(currentOriginalElement)) {
            currentOriginalElement = currentOriginalElement[currentIndex];
          }
          if (Array.isArray(currentActualElement)) {
            currentActualElement = currentActualElement[currentIndex];
          }
        }
      } else {
        if (currentOriginalElement?.[pathPart.base] != null) {
          currentOriginalElement[pathPart.base] = undefined;
          currentActualElement[pathPart.base] = undefined;
        }
        if (pathPart.primitive && currentOriginalElement?.[`_${pathPart.base}`] != null) {
          currentOriginalElement[`_${pathPart.base}`] = undefined;
          currentActualElement[`_${pathPart.base}`] = undefined;
        }
      }
    }
  }

  private calculateClearPath(pathParts: PathPart[]): PathPart[] {
    const replacementIndex = this._replacementProps.findIndex(
      replacementPath =>
        replacementPath.length <= pathParts.length &&
        replacementPath.every((rp, index) => rp === pathParts[index].base)
    );
    if (replacementIndex >= 0) {
      // Build the clearPath from the actual pathParts, since we want to know about primitive types.
      const clearPath = pathParts.slice(0, this._replacementProps[replacementIndex].length);
      // each replacement property only has to get cleared once, so remove it from the list.
      this._replacementProps.splice(replacementIndex, 1);
      return clearPath;
    }
    return [];
  }

  /**
   * Determines if the state of the current element differs from the stored "original".
   * @returns {boolean} true if the state of the current element differs from the stored "original", false otherwise
   */
  hasDiff(): boolean {
    const original = this._original ? this._original : new ElementDefinition();
    return (
      PROPS_AND_UNDERPROPS.some(prop => {
        if (prop.endsWith('[x]')) {
          const re = new RegExp(`^${prop.slice(0, -3)}[A-Z].*$`);
          prop = Object.keys(this).find(p => re.test(p));
          if (prop == null) {
            prop = Object.keys(original).find(p => re.test(p));
          }
        }
        // @ts-ignore
        return prop && !isEqual(this[prop], original[prop]);
      }) ||
      // When a slice or a sliced element has children that changed, we must treat the slice or sliced element
      // as if it differs from the original. The IG Publisher requires slices or sliced elements with changed
      // children to be in the differential, or the snapshot is incorrectly generated
      ((this.sliceName || this.getSlices().length > 0) && this.children().some(c => c.hasDiff()))
    );
  }

  /**
   * Calculates the differential based on changes in data from the stored "original" state and returns the differential
   * as a new ElementDefinition containing only the id, path, and changed data.
   * @returns {ElementDefinition} an ElementDefinition representing the changed data since the stored "original" state
   */
  calculateDiff(): ElementDefinition {
    const original = this._original ? this._original : new ElementDefinition();
    const diff = new ElementDefinition(this.id);
    diff.structDef = this.structDef;
    for (let prop of PROPS_AND_UNDERPROPS) {
      if (prop.endsWith('[x]')) {
        const re = new RegExp(`^${prop.slice(0, -3)}[A-Z].*$`);
        prop = Object.keys(this).find(p => re.test(p));
        if (prop == null) {
          prop = Object.keys(original).find(p => re.test(p));
        }
      }
      // @ts-ignore
      if (prop && !isEqual(this[prop], original[prop])) {
        if (ADDITIVE_PROPS.includes(prop)) {
          // @ts-ignore
          diff[prop] = differenceWith(this[prop], original[prop], isEqual);
          // @ts-ignore
          if (isEmpty(diff[prop])) {
            // @ts-ignore
            delete diff[prop];
          }
        } else {
          // @ts-ignore
          diff[prop] = cloneDeep(this[prop]);
        }
      } else if (prop === 'type' && this.sliceName && this.path.endsWith('[x]')) {
        // the IG publisher always requires that the type attribute is present on a slice of a choice element,
        // even if this slice's type is equal to the choice element's type.
        diff[prop] = cloneDeep(this[prop]);
      }
    }
    // If the original has a sliceName, the diff needs to have a sliceName, so use the original.
    if (original.sliceName && diff.sliceName == null) {
      diff.sliceName = original.sliceName;
    }
    return diff;
  }

  /**
   * Apply the AddElementRule to this new element using the appropriate methods
   * for specific rules for the AddElementRule's implied rules (i.e., cardinality,
   * type constraints, and flags).
   * @param {AddElementRule} rule - specific instance of the rule
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   */
  applyAddElementRule(rule: AddElementRule, fisher: Fishable): void {
    // Verify the rule path. When adding a new element, a parent will always be defined,
    // even it the parent element is the root element. If parent is not defined, there
    // is something wrong with the rule.path value.
    if (!this.parent()) {
      throw new CannotResolvePathError(rule.path);
    }

    // Add the base attribute
    this.base = {
      path: `${this.structDef.pathType}.${rule.path}`,
      min: rule.min,
      max: rule.max
    };

    // Add the root element's constraints to this element
    const elementSD = fisher.fishForFHIR('Element', Type.Type);
    // The root element's constraint does not define the source property
    // because it is the source. So, we need to add the missing source property.
    this.constraint = cloneDeep(elementSD.snapshot.element[0].constraint).map(
      (c: ElementDefinitionConstraint) => {
        c.source = elementSD.url;
        return c;
      }
    );

    // Capture the current state as the original element definition.
    // All changes after this will be a part of the differential.
    this.captureOriginal();

    if (rule.types.length > 0) {
      // The constrainType() method applies a type constraint to an existing
      // ElementDefinition.type. Since this is a new ElementDefinition, it
      // does not yet have a 'type', so we need to assign an "initial" value
      // that the constrainType() method can process.
      this.type = this.initializeElementType(rule, fisher);
      const target = this.structDef.getReferenceOrCanonicalName(rule.path, this);
      this.constrainType(rule, fisher, target);
    } else {
      // An element without a type has a contentReference instead
      this.contentReference = rule.contentReference;
    }

    this.constrainCardinality(rule.min, rule.max);

    this.applyFlags(
      rule.mustSupport,
      rule.summary,
      rule.modifier,
      rule.trialUse,
      rule.normative,
      rule.draft
    );

    // Since 'short' and 'definition' are plain string values, directly assign the values.
    if (!isEmpty(rule.short)) {
      this.short = rule.short;
    }
    if (isEmpty(rule.definition)) {
      if (!isEmpty(rule.short)) {
        // According to sdf-3 in http://hl7.org/fhir/structuredefinition.html#invs,
        // definition should be provided. Default it here.
        this.definition = rule.short;
      }
    } else {
      this.definition = rule.definition;
    }
  }

  /**
   * Define and return the initial base ElementDefinition.type from the AddElementRule.
   * @ref https://github.com/FHIR/sushi/pull/802#discussion_r631300737
   * @param {AddElementRule} rule - specific instance of the rule
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @returns {ElementDefinitionType[]} The element types as defined by the AddElementRule
   * @private
   */
  private initializeElementType(rule: AddElementRule, fisher: Fishable): ElementDefinitionType[] {
    if (rule.types.length > 1 && !rule.path.endsWith('[x]')) {
      // Reference/Canonical/CodeableReference data type with multiple targets is not considered a choice data type.
      if (
        !rule.types.every(t => t.isReference) &&
        !rule.types.every(t => t.isCanonical) &&
        !rule.types.every(t => t.isCodeableReference)
      ) {
        throw new InvalidChoiceTypeRulePathError(rule);
      }
    }

    let refTypeCnt = 0;
    let canTypeCnt = 0;
    let codeableRefTypeCnt = 0;

    const initialTypes: ElementDefinitionType[] = [];
    rule.types.forEach(t => {
      if (t.isReference) {
        refTypeCnt++;
      } else if (t.isCanonical) {
        canTypeCnt++;
      } else if (t.isCodeableReference) {
        codeableRefTypeCnt++;
      } else {
        const metadata = fisher.fishForMetadata(t.type);
        initialTypes.push(new ElementDefinitionType(metadata.sdType));
      }
    });

    const finalTypes: ElementDefinitionType[] = uniqWith(initialTypes, isEqual);
    if (refTypeCnt > 0) {
      // We only need to capture a single Reference type. The targetProfiles attribute
      // will contain the URLs for each reference.
      finalTypes.push(new ElementDefinitionType('Reference'));
    }
    if (canTypeCnt > 0) {
      // We only need to capture a single canonical type. The targetProfiles attribute
      // will contain the URLs for each canonical.
      finalTypes.push(new ElementDefinitionType('canonical'));
    }
    if (codeableRefTypeCnt > 0) {
      // We only need to capture a single CodeableReference type. The targetProfiles attribute
      // will contain the URLs for each CodeableReference reference.
      finalTypes.push(new ElementDefinitionType('CodeableReference'));
    }

    const refCheckCnt = refTypeCnt > 0 ? refTypeCnt - 1 : 0;
    const canCheckCnt = canTypeCnt > 0 ? canTypeCnt - 1 : 0;
    const codableRefCheckCnt = codeableRefTypeCnt > 0 ? codeableRefTypeCnt - 1 : 0;
    if (rule.types.length !== finalTypes.length + refCheckCnt + canCheckCnt + codableRefCheckCnt) {
      logger.warn(
        `${rule.path} includes duplicate types. Duplicates have been ignored.`,
        rule.sourceInfo
      );
    }

    return finalTypes;
  }

  /**
   * Apply invariant to the Element.constraint
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.constraint}
   * @param invariant The invariant to be applied to the constraint
   * @param source Source URL for the constraint
   * @returns {number} the index of the constraint that was applied
   */
  applyConstraint(invariant: Invariant, source?: string): number {
    const constraint: ElementDefinitionConstraint = {
      ...(invariant.name && { key: invariant.name }),
      ...(invariant.severity && { severity: invariant.severity.code }),
      ...(invariant.description && { human: invariant.description }),
      ...(invariant.expression && { expression: invariant.expression }),
      ...(invariant.xpath && { xpath: invariant.xpath }),
      ...(source && { source })
    };
    if (this.constraint) {
      this.constraint.push(constraint);
    } else {
      this.constraint = [constraint];
    }
    // return the index of the constraint that was applied
    return this.constraint.length - 1;
  }

  /**
   * This function sets an instance property of an ED if possible
   * @param {string} path - The path to the ElementDefinition to assign
   * @param {any} value - The value to assign
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   */
  setInstancePropertyByPath(path: string, value: any, fisher: Fishable): void {
    setPropertyOnDefinitionInstance(this, path, value, fisher);
  }

  getSlices() {
    if (this.sliceName) {
      // this.parent() should never be undefined if this element has a sliceName, but code defensively just in case
      return (this.parent()?.children(true) ?? this.structDef.elements).filter(
        e => e.id !== this.id && e.path === this.path && e.id.startsWith(`${this.id}/`)
      );
    } else {
      return (this.parent()?.children(true) ?? this.structDef.elements).filter(
        e => e.id !== this.id && e.path === this.path && e.id.startsWith(`${this.id}:`)
      );
    }
  }

  /**
   * Returns an array of slices that will be pre-loaded.
   * A slice is pre-loaded if if has a min of 1 and contains a fixed or pattern value on itself or it's descendents
   * @returns {ElementDefinition[]} - Array of slices to be pre-loaded
   */
  getPreloadedSlices(): ElementDefinition[] {
    return this.getSlices().filter(
      slice =>
        slice.min > 0 &&
        (Object.keys(slice).find(k => k.startsWith('fixed') || k.startsWith('pattern')) ||
          slice
            .getAssignableDescendents()
            .some((element: ElementDefinition) =>
              Object.keys(element).find(k => k.startsWith('fixed') || k.startsWith('pattern'))
            ))
    );
  }

  /**
   * Determines if an array index references a slice that will be preloaded.
   * A slice is pre-loaded if if has a min of 1 and contains a fixed or pattern value on itself or it's descendents
   * @param {number} sliceIndex - The index
   * @returns {boolean}
   */
  isPreloadedSlice(sliceIndex: number): boolean {
    return sliceIndex <= this.getPreloadedSlices().length - 1;
  }

  /**
   * Constrains the cardinality of this element.  Cardinality constraints can only narrow
   * cardinality.  Attempts to constrain to a wider cardinality will throw.
   * @see {@link http://hl7.org/fhir/R4/profiling.html#cardinality}
   * @see {@link http://hl7.org/fhir/R4/conformance-rules.html#cardinality}
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.min}
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.max}
   * @param {number} min - the minimum cardinality
   * @param {number|string} max - the maximum cardinality
   * @throws {InvalidCardinalityError} when min > max
   * @throws {ConstrainingCardinalityError} when new cardinality is wider than existing cardinality
   * @throws {InvalidSumOfSliceMinsError} when the mins of slice elements > max of sliced element
   * @throws {NarrowingRootCardinalityError} when the new cardinality on an element is narrower than
   *   the cardinality on a connected element
   */
  constrainCardinality(min: number, max: string): void {
    // If only one side of the cardinality is set by the rule, use element's current cardinality
    if (isNaN(min)) min = this.min;
    if (max === '') max = this.max;

    const isUnbounded = max === '*';
    const maxInt = !isUnbounded ? parseInt(max) : null;

    // Check to ensure it is valid (min <= max)
    if (!isUnbounded && min > maxInt) {
      throw new InvalidCardinalityError(min, max);
    }

    // Check to ensure min >= existing min
    if (this.min != null && min < this.min) {
      throw new ConstrainingCardinalityError(this.min, this.max, min, max);
    }

    // Check to ensure max <= existing max
    if (this.max != null && this.max !== '*' && (maxInt > parseInt(this.max) || isUnbounded)) {
      throw new ConstrainingCardinalityError(this.min, this.max, min, max);
    }

    // Sliced elements and slices have special card rules described here:
    // http://www.hl7.org/fhiR/profiling.html#slice-cardinality
    // If element is slice definition
    if (this.slicing && !isUnbounded) {
      // Check that new max >= sum of mins of children
      this.checkSumOfSliceMins(max);
      // Check that new max >= every individual child max
      const slices = this.getSlices();
      const overMaxChildren: string[] = [];
      slices.forEach(child => {
        if (child.max === '*' || parseInt(child.max) > maxInt) {
          child.max = max;
          overMaxChildren.push(child.sliceName);
        }
      });
      if (overMaxChildren.length > 0) {
        logger.warn(
          `At least one slice of ${
            this.id
          } has a max greater than the overall element max. The max of the following slice(s) has been reduced to match the max of ${
            this.id
          }: ${overMaxChildren.join(',')}`
        );
      }
    }

    const connectedElements = this.findConnectedElements().filter(
      ce => !(ce.path === this.path && ce.id.startsWith(this.id))
    );
    // check to see if the card constraint would actually be a problem for the connected element
    // that is to say, if the new card is incompatible with the connected card
    // Filter out elements that are directly slices of this, since they may have min < this.min
    connectedElements.forEach(ce => {
      // the cardinality is incompatible if:
      // the new min is greater than the connected element's max, or
      // the new max is less than the connected element's min
      if (
        (ce.max != null && ce.max !== '*' && min > parseInt(ce.max)) ||
        (ce.min != null && !isUnbounded && maxInt < ce.min)
      ) {
        throw new NarrowingRootCardinalityError(this.path, ce.id, min, max, ce.min, ce.max ?? '*');
      }
    });

    // If element is a slice
    const slicedElement = this.slicedElement();
    if (slicedElement) {
      const parentSlice = this.findParentSlice();
      const sliceSiblings = this.parent()
        .children(true)
        .filter(
          el =>
            this !== el &&
            slicedElement === el.slicedElement() &&
            parentSlice === el.findParentSlice()
        );
      const newParentMin = min + sliceSiblings.reduce((sum, el) => sum + el.min, 0);
      // if this is a reslice, the parent element will also be a slice of the sliced element.
      // if this is not a reslice, the parent element is the sliced element.
      const parentElement = parentSlice ?? slicedElement;
      // Check that parentElement max >= new sum of mins
      if (parentElement.max !== '*' && newParentMin > parseInt(parentElement.max)) {
        throw new InvalidSumOfSliceMinsError(newParentMin, parentElement.max, parentElement.id);
      }
      // If new sum of mins > parentElement min, increase parentElement min
      if (newParentMin > parentElement.min) {
        parentElement.constrainCardinality(newParentMin, '');
      }
    }

    // apply the cardinality to connected elements, but don't try to widen cardinalities
    connectedElements.forEach(ce => {
      const newMin = Math.max(min, ce.min);
      let newMax = max;
      if (isUnbounded) {
        newMax = ce.max;
      } else if (ce.max !== '*') {
        newMax = `${Math.min(maxInt, parseInt(ce.max))}`;
      }
      ce.constrainCardinality(newMin, newMax);
    });
    [this.min, this.max] = [min, max];
  }

  /**
   * Tries to find all connected elements based on slicing.
   * When an element that has children is sliced, there can be constraints on that element's children,
   * as well as the children of any defined slices. Depending on the order that slices and rules are
   * defined, a rule may be applied to an element after slices of that element have already been
   * created. Therefore, to determine the full effect of that rule, the elements that are inside
   * slices must be found. The rule's path may contain many sliced elements, so it is necessary
   * to recursively search the StructureDefinition for ancestors of the element on the rule's path
   * that contain slice definitions. These sliced ancestors may in turn contain child elements that
   * match the rule's path.
   * In summary: find elements that have the same path, but are slicier.
   * @param {string} postPath The path to append to the parent in order to try to find a connected element
   * @returns {ElementDefinition[]} The elements at or inside of slices whose path matches the original element
   */
  findConnectedElements(postPath = ''): ElementDefinition[] {
    const slicesToUse = this.getSlices();

    const connectedElements = slicesToUse
      .filter(e => e.max !== '0')
      .map(slice => {
        return this.structDef.findElement(`${slice.id}${postPath}`);
      })
      .filter(e => e);
    if (this.parent()) {
      const [parentPath] = splitOnPathPeriods(this.id).slice(-1);
      return connectedElements.concat(
        this.parent().findConnectedElements(`.${parentPath}${postPath}`)
      );
    } else {
      return connectedElements;
    }
  }

  findConnectedSliceElement(postPath = ''): ElementDefinition {
    const slicingRoot = this.slicedElement();
    if (slicingRoot) {
      return this.structDef.findElement(`${slicingRoot.id}${postPath}`);
    } else if (this.parent()) {
      return this.parent().findConnectedSliceElement(
        `.${this.path.split('.').slice(-1)[0]}${postPath}`
      );
    }
  }

  findParentSlice(): ElementDefinition {
    if (this.sliceName) {
      const slicedElement = this.slicedElement();
      const parentNameParts = this.sliceName.split('/').slice(0, -1);
      const potentialParentNames = parentNameParts
        .map((_part, i) => {
          return parentNameParts.slice(0, i + 1).join('/');
        })
        .reverse();
      const elementsToSearch = this.parent()?.children(true) ?? this.structDef.elements;
      for (const parentName of potentialParentNames) {
        const potentialParent = elementsToSearch.find(el => {
          return el.sliceName === parentName && el.slicedElement() === slicedElement;
        });
        if (potentialParent) {
          return potentialParent;
        }
      }
    }
  }

  /**
   * Checks if the sum of slice mins exceeds the max of sliced element, and returns
   * the sum if so.
   * @param {string} slicedElementMax - The max of the sliced element
   * @param {number} newSliceMin - An optional new minimum if the minimum of this is being constrained
   * @returns {number} the sum of the mins of the slices, or 0 if the sum is less than the sliced max
   * @throws {InvalidSumOfSliceMinsError} when the sum of mins of the slices exceeds max of sliced element
   */
  private checkSumOfSliceMins(newSlicedElementMax: string, sliceMinIncrease = 0) {
    const slices = this.getSlices();
    const sumOfMins = sliceMinIncrease + slices.reduce((prev, curr) => (prev += curr.min), 0);
    if (newSlicedElementMax !== '*' && sumOfMins > parseInt(newSlicedElementMax)) {
      throw new InvalidSumOfSliceMinsError(sumOfMins, newSlicedElementMax, this.id);
    } else {
      return sumOfMins;
    }
  }

  /**
   * Constrains the type of this element to the requested type(s).  When this element's type is a
   * choice, this function will reduce the choice to only those types provided -- unless a
   * targetType is provided, in which case, only that type will be affected and other options in
   * the choice will be left unchanged.  This function should allow the following scenarios:
   * - constrain a choice of types to a smaller subset of types (including a single type)
   * - constrain a type to one or more profiles on that type
   * - constrain a supertype (e.g., Resource) to one or more subtypes (e.g., Condition)
   * - constrain a reference of multiple types to a reference of a smaller subset of types
   * - constrain a reference of a type or profile to one or more profiles of that type/profile
   * - constrain a reference of a supertype to one or more references of subtypes
   * - any combinaton of the above
   * This function will throw when:
   * - attempting to add a base type (e.g., `type.code`) that wasn't already a choice in the type
   * - attempting to add a profile that doesn't extend or impose (via extension) any of the
   *   existing types
   * - attempting to add a base reference that wasn't already a reference
   * - attempting to add a reference to a profile that doesn't extend or impose (via extensions)
   *   any of the existing references
   * - specifying a target that does not match any of the existing type choices
   * - specifying types or a target whose definition cannot be found
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.type}
   * @param {OnlyRule} rule - The rule specifying the types to apply
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @param {string} [target] - a specific target type to constrain.  If supplied, will attempt to
   *   constrain only that type without affecting other types (in a choice or reference to a choice).
   * @throws {TypeNotFoundError} when a passed in type's definition cannot be found
   * @throws {InvalidTypeError} when a passed in type or the targetType doesn't match any existing
   *   types
   * @throws {SliceTypeRemovalError} when a rule would eliminate all types on a slice
   */
  constrainType(rule: OnlyRule | AddElementRule, fisher: Fishable, target?: string): void {
    const types = rule.types;
    // Establish the target types (if applicable)
    const targetType = this.getTargetType(target, fisher);
    const targetTypes: ElementDefinitionType[] = targetType ? [targetType] : this.type;

    // If the target type is a CodeableReference but the rule types were set via the Reference() keyword,
    // log a warning to use CodeableReference keyword
    if (
      targetTypes.some(t => t.code === 'CodeableReference') &&
      !targetTypes.some(t => t.code === 'Reference') &&
      rule.types.some(t => t.isReference)
    ) {
      logger.warn(
        'The CodeableReference() keyword should be used to constrain references of a CodeableReference',
        rule.sourceInfo
      );
    }

    // Check if a CodeableReference is attempting to constraint directly to the reference element
    if (
      this.type.length === 1 &&
      this.type[0].code === 'Reference' &&
      this.path.endsWith('.reference') &&
      this.parent()?.type?.[0]?.code === 'CodeableReference'
    ) {
      logger.error(
        "Constraining references on a CodeableReference element's underlying .reference path is not allowed. Instead, constrain the references directly on the CodeableReference element.",
        rule.sourceInfo
      );
    }

    // Setup a map to store how each existing element type maps to the input types
    const typeMatches: Map<string, ElementTypeMatchInfo[]> = new Map();
    targetTypes.forEach(t => typeMatches.set(t.code, []));

    // Loop through the input types and associate them to the element types in the map
    for (const type of types) {
      const typeMatch = this.findTypeMatch(type, targetTypes, fisher);
      // if the type is Canonical, it may have a version. preserve it in the match's metadata.
      if (
        (type.isCanonical || type.isReference || type.isCodeableReference) &&
        type.type.indexOf('|') > -1
      ) {
        typeMatch.metadata.url = `${typeMatch.metadata.url}|${type.type.split('|', 2)[1]}`;
      }
      typeMatches.get(typeMatch.code).push(typeMatch);
    }
    // check Reference and CodeableReference type matches for logical targetProfiles.
    // logical models should have an extension set to indicate that they can be used as reference targets.
    const logicalReferenceTargets: ElementTypeMatchInfo[] = [];
    if (typeMatches.has('Reference')) {
      logicalReferenceTargets.push(...typeMatches.get('Reference'));
    }
    if (typeMatches.has('CodeableReference')) {
      logicalReferenceTargets.push(...typeMatches.get('CodeableReference'));
    }
    const invalidReferenceTargets = logicalReferenceTargets.filter(
      typeMatch => typeMatch.metadata.canBeTarget === false
    );
    if (invalidReferenceTargets.length > 1) {
      const typeList = invalidReferenceTargets.map(info => info.typeName).join(', ');
      logger.warn(
        `Referenced types ${typeList} do not specify that they can be the targets of a reference.`,
        rule.sourceInfo
      );
    } else if (invalidReferenceTargets.length === 1) {
      logger.warn(
        `Referenced type ${invalidReferenceTargets[0].typeName} does not specify that it can be the target of a reference.`,
        rule.sourceInfo
      );
    }

    // Loop through the existing element types building the new set of element types w/ constraints
    const newTypes: ElementDefinitionType[] = [];
    const oldTypes: ElementDefinitionType[] = [];
    for (const type of this.type) {
      // If the typeMatches map doesn't have the type code at all, this means that a target was
      // specified, and this element type wasn't the target.  In this case, we want to keep it.
      if (!typeMatches.has(type.code)) {
        newTypes.push(cloneDeep(type));
        continue;
      }

      // Get the associated input type matches.  If no input types matched against it, then this
      // element type should be filtered out of the results, so just skip to the next one.
      const matches = typeMatches.get(type.code);
      if (isEmpty(matches)) {
        oldTypes.push(type);
        continue;
      }
      newTypes.push(...this.applyTypeIntersection(type, targetType, matches));
    }

    // Loop through the new types and for each one, update any _profile and _targetProfile arrays
    // that need it. In short, if a single profile or targetProfile is unchanged, preserve its
    // corresponding _profile or _targetProfile entry. If a profile or targetProfile is changed,
    // and there is a _profile or _targetProfile array, make the corresponding entry null. If a
    // _profile or _targetProfile is added, and there is a _profile or _targetProfile array, add
    // a null entry for it.
    for (const newType of newTypes) {
      const originalType = this.type.find(t => t.code === newType.code);
      delete newType._profile;
      if (originalType && originalType._profile?.length) {
        newType._profile = newType.profile.map(newProfile => {
          return originalType._profile[originalType.profile.indexOf(newProfile)] ?? null;
        });
        if (newType._profile.length === 0 || newType._profile.every(e => e == null)) {
          delete newType._profile;
        }
      }
      delete newType._targetProfile;
      if (originalType && originalType._targetProfile?.length) {
        newType._targetProfile = newType.targetProfile.map(newProfile => {
          return (
            originalType._targetProfile[originalType.targetProfile.indexOf(newProfile)] ?? null
          );
        });
        if (newType._targetProfile.length === 0 || newType._targetProfile.every(e => e == null)) {
          delete newType._targetProfile;
        }
      }
    }

    // Let user know if other rules have been made obsolete
    const obsoleteChoices = this.structDef.findObsoleteChoices(this, oldTypes);
    if (obsoleteChoices.length > 0) {
      logger.error(
        `Type constraint on ${this.path} makes rules in ${
          this.structDef.name
        } obsolete for choices: ${obsoleteChoices.join(', ')}`,
        rule.sourceInfo
      );
    }

    // new types for this element have been determined
    // if there are any connected elements, make sure that nothing invalid will happen
    let connectedElements = this.findConnectedElements();
    // however, we don't need to apply this to elements representing a choice of types
    // for example, if this is being applied to value[x], and valueString exists, we can remove the string type.
    if (this.path.endsWith('[x]')) {
      connectedElements = connectedElements.filter(ce => ce.id.endsWith('[x]'));
    }
    if (connectedElements.length > 0) {
      // if all connected elements have a non-empty intersection, we can safely apply the rule
      const connectedTypeChanges: Map<ElementDefinition, ElementDefinitionType[]> = new Map();
      connectedElements.forEach(ce => {
        const intersection = this.findTypeIntersection(newTypes, ce.type, targetType, fisher);
        if (intersection.length > 0) {
          connectedTypeChanges.set(ce, intersection);
        } else {
          const obsoleteConnections = ce.structDef.findObsoleteChoices(ce, oldTypes);
          if (obsoleteConnections.length > 0) {
            logger.error(
              `Type constraint on ${rule.path} makes rules in ${
                ce.structDef.name
              } obsolete for choices: ${obsoleteConnections.join(', ')}`,
              rule.sourceInfo
            );
          } else {
            throw new SliceTypeRemovalError(rule.path, ce.id);
          }
        }
      });
      if (connectedElements.length == connectedTypeChanges.size) {
        connectedTypeChanges.forEach((ceType, ce) => (ce.type = ceType));
      }
    }

    // Finally, reset this element's types to the new types
    this.type = newTypes;
    // extra check for modifier extension usage
    if (typeMatches.get('Extension')?.length > 0) {
      // fish up each specific profile by url to see if it is a modifier extension
      const isModifierPath = this.path.endsWith('.modifierExtension');
      typeMatches.get('Extension').forEach(typeMatch => {
        const fullExtension = fisher.fishForFHIR(typeMatch.metadata.url, Type.Extension);
        if (fullExtension) {
          const isModifier = isModifierExtension(fullExtension);
          if (isModifier && !isModifierPath) {
            logger.error(
              `Modifier extension ${typeMatch.metadata.name} used to constrain extension element. Modifier extensions should only be used with modifierExtension elements.`,
              rule.sourceInfo
            );
          } else if (!isModifier && isModifierPath) {
            logger.error(
              `Non-modifier extension ${typeMatch.metadata.name} used to constrain modifierExtension element. Non-modifier extensions should only be used with extension elements.`,
              rule.sourceInfo
            );
          }
        }
      });
    }
  }

  /**
   * Given a string representing a type or profile, will return this element's matching type, if
   * found -- with all other profiles or targetProfiles (e.g. references) removed from the type.
   * @param {string} target - the target to find a matching type for
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @returns {ElementDefinitionType} the element's type that matches the target
   * @throws {TypeNotFoundError} when the target's definition cannot be found
   * @throws {InvalidTypeError} when the target doesn't match any existing types
   */
  private getTargetType(target: string, fisher: Fishable): ElementDefinitionType {
    let targetType: ElementDefinitionType;
    if (target) {
      const targetSD = fisher.fishForMetadata(
        target,
        Type.Resource,
        Type.Logical,
        Type.Type,
        Type.Profile,
        Type.Extension
      );
      if (targetSD == null) {
        throw new TypeNotFoundError(target);
      }
      // Try to match on types by an exact match on the code (applies to resources),
      // the profiles (applies to profiles), or targetProfiles (applies to references).
      // Clone it since we will filter out the non-target profiles/targetProfiles.
      targetType = cloneDeep(
        this.type.find(
          t =>
            t.code === targetSD.id || // TODO: Should this be on type (for LMs?)
            t.profile?.includes(targetSD.url) ||
            t.targetProfile?.includes(targetSD.url)
        )
      );

      if (!targetType) {
        throw new InvalidTypeError(target, this.type);
      }

      // Re-assign the targetProfiles/profiles as appropriate to remove non-targets
      if (targetType.profile?.includes(targetSD.url)) {
        targetType.profile = [targetSD.url];
      } else if (targetType.targetProfile?.includes(targetSD.url)) {
        targetType.targetProfile = [targetSD.url];
      }
    }
    return targetType;
  }

  /**
   * Given an input type (the constraint) and a set of target types (the things to potentially
   * constrain), find the match and return information about it.
   * @param {OnlyRuleType} type - the constrained types, identified by id/type/url string and
   *   an optional reference/canonical flags (defaults false)
   * @param {ElementDefinitionType[]} targetTypes - the element types that the constrained type
   *   can be potentially applied to
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @param {boolean} allowLooseMatch - whether to allow profiles to match on any other profile
   *   of the same resource / data type, even if it doesn't formally descend from the profile
   * @returns {ElementTypeMatchInfo} the information about the match
   * @throws {TypeNotFoundError} when the type's definition cannot be found
   * @throws {InvalidTypeError} when the type doesn't match any of the targetTypes
   */
  private findTypeMatch(
    type: OnlyRuleType,
    targetTypes: ElementDefinitionType[],
    fisher: Fishable
  ): ElementTypeMatchInfo {
    let matchedType: ElementDefinitionType;
    const typeName = type.isCanonical ? type.type.split('|', 2)[0] : type.type;

    // Get the lineage (type hierarchy) so we can walk up it when attempting to match
    const lineage = this.getTypeLineage(typeName, fisher, true);
    if (isEmpty(lineage)) {
      throw new TypeNotFoundError(type.type);
    }

    // Walk up the lineage, one StructureDefinition at a time.  We can potentially match on the
    // type itself or any of its parents.  For example, a BloodPressure profile could match on
    // an Observation already having a BP profile, an Observation type w/ no profiles, a
    // DomainResource type w/ no profiles, or a Resource type w/ no profiles.
    let specializationOfNonAbstractType = false;
    for (const md of lineage) {
      if (type.isReference) {
        // References always have a code 'Reference' w/ the referenced type's defining URL set as
        // one of the targetProfiles.  If the targetProfile property is null, that means any
        // reference is allowed.
        // When 'Reference' keyword is used, prefer to match on the 'Reference' type over the
        // 'CodeableReference' type if they both exist on the element.
        matchedType = targetTypes.find(
          t2 =>
            t2.code === 'Reference' &&
            (t2.targetProfile == null || t2.targetProfile.includes(md.url))
        );
        if (!matchedType) {
          matchedType = targetTypes.find(
            t2 =>
              t2.code === 'CodeableReference' &&
              (t2.targetProfile == null || t2.targetProfile.includes(md.url))
          );
        }
      } else if (type.isCanonical) {
        // Canonicals always have a code 'canonical' w/ the referenced type's defining URL set as
        // one of the targetProfiles.  If the targetProfile property is null, that means any
        // canonical is allowed.
        matchedType = targetTypes.find(
          t2 =>
            t2.code === 'canonical' &&
            (t2.targetProfile == null || t2.targetProfile.includes(md.url))
        );
      } else if (type.isCodeableReference) {
        // CodeableReferences always have a code 'CodeableReference' w/ the referenced type's defining URL set as
        // one of the targetProfiles.  If the targetProfile property is null, that means any
        // CodeableReference reference is allowed.
        matchedType = targetTypes.find(
          t2 =>
            t2.code === 'CodeableReference' &&
            (t2.targetProfile == null || t2.targetProfile.includes(md.url))
        );
      } else {
        // Look for exact match on the code (w/ no profile) or a match on an allowed base type with
        // a matching profile
        matchedType = targetTypes.find(t2 => {
          const matchesUnprofiledResource = t2.code === md.id && isEmpty(t2.profile);
          const matchesProfile =
            this.getTypeLineage(md.sdType, fisher).some(ancestor => ancestor.sdType === t2.code) &&
            t2.profile?.includes(md.url);
          let matchesLogicalType = false;
          if (this.structDef.kind === 'logical') {
            matchesLogicalType = t2.code && t2.code === md.sdType;
          }
          // True if we match an unprofiled type that is not abstract, is a parent, and that we are
          // specializing (the type does not match the sdType of the type to match)
          specializationOfNonAbstractType =
            matchesUnprofiledResource &&
            !md.abstract &&
            md.id !== lineage[0].id &&
            md.id !== lineage[0].sdType;
          return matchesUnprofiledResource || matchesProfile || matchesLogicalType;
        });
      }

      if (matchedType) {
        break;
      }
    }

    if (!matchedType) {
      throw new InvalidTypeError(typeString([type]), targetTypes);
    } else if (specializationOfNonAbstractType) {
      throw new NonAbstractParentOfSpecializationError(type.type, matchedType.code);
    }

    return {
      metadata: lineage[0],
      code: matchedType.code,
      typeName
    };
  }

  /**
   * Gets the full lineage of the type, w/ the item at index 0 being the type's own Metadata,
   * the item at index 1 being its parent's, 2 being its grandparent's, etc.  If a definition can't be
   * found, it stops and returns as much lineage as is found thus far.
   * @param {string} type - the type to get the lineage for
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @param {boolean} includeImposeProfiles - whether or not profiles declared via an imposeProfile
   *   extension should be included in the lineage
   * @param {string[]} seenUrls - the list of URLs that have already been processed (for recursive calls)
   * @returns {Metadata[]} representing the lineage of the type
   */
  private getTypeLineage(
    type: string,
    fisher: Fishable,
    includeImposeProfiles = false,
    seenUrls: string[] = []
  ): Metadata[] {
    const results: Metadata[] = [];

    // Start with the current type and walk up the base definitions.
    // Stop when we can't find a definition, the base definition is blank, or we've already seen the url
    let currentType = type;
    while (currentType != null) {
      if (seenUrls.includes(currentType)) {
        break;
      }
      // fishForMetadataBestVersion is not used here in order to provide additional details in the warning
      let result = fisher.fishForMetadata(
        currentType,
        Type.Resource,
        Type.Logical,
        Type.Type,
        Type.Profile,
        Type.Extension
      );
      if (result == null) {
        const [name, ...versionParts] = currentType.split('|');
        const version = versionParts.join('|') || null;
        result = fisher.fishForMetadata(
          name,
          Type.Resource,
          Type.Logical,
          Type.Type,
          Type.Profile,
          Type.Extension
        );
        if (result && version != null && result.version != null && result.version != version) {
          logger.warn(
            `${type} is based on ${name} version ${version}, but SUSHI found version ${result.version}`
          );
        }
      }
      if (result) {
        if (result.url) {
          if (seenUrls.includes(result.url)) {
            break;
          }
          seenUrls.push(result.url);
        }
        results.push(result);
      }
      currentType = result?.parent;
    }

    if (includeImposeProfiles) {
      // Collect all the unseen impose profiles from the results
      const imposeProfiles: string[] = [];
      results.forEach(md => {
        md.imposeProfiles?.forEach(p => {
          const url =
            p instanceof FshCanonical
              ? fisher.fishForMetadata(
                  p.entityName,
                  Type.Resource,
                  Type.Logical,
                  Type.Type,
                  Type.Profile,
                  Type.Extension
                )?.url
              : p;
          if (url && !imposeProfiles.includes(url) && !seenUrls.includes(url)) {
            imposeProfiles.push(url);
          }
        });
      });
      // Get the lineage of each impose profile and add it to the results
      imposeProfiles.forEach(p => {
        results.push(...this.getTypeLineage(p, fisher, true, seenUrls));
      });
    }

    return results;
  }

  /**
   * Given a new ElementTypeDefinition (based on the existing one), will apply the matching
   * profiles and targetProfiles as appropriate.  If a targetType was specified, will filter out
   * the other profiles or targetProfiles.
   * @param {ElementDefinitionType} newType - the new type to apply the profiles/targetProfiles to
   * @param {ElementDefinitionType} [targetType] - the (potentially null) target type for the
   *   type constraint
   * @param {ElementTypeMatchInfo[]} matches - the information about how type constraints map
   *   to element types
   */
  private applyProfiles(
    newType: ElementDefinitionType,
    targetType: ElementDefinitionType,
    matches: ElementTypeMatchInfo[]
  ): void {
    const matchedProfiles: string[] = [];
    const matchedTargetProfiles: string[] = [];
    for (const match of matches) {
      if (match.metadata.id === newType.code) {
        continue;
      } else if (isReferenceType(match.code) && !isReferenceType(match.metadata.sdType)) {
        matchedTargetProfiles.push(match.metadata.url);
      } else if (match.code === 'canonical' && match.metadata.sdType !== 'canonical') {
        matchedTargetProfiles.push(match.metadata.url);
      } else if (
        this.structDef.kind === 'logical' &&
        newType.code === match.metadata.sdType &&
        match.metadata.sdType === match.metadata.url
      ) {
        // The logical model's newType has a code that is a URL. This should NOT be
        // included in newType.targetProfile or newType.profile.
        continue;
      } else {
        matchedProfiles.push(match.metadata.url);
      }
    }

    if (targetType) {
      if (!isEmpty(matchedTargetProfiles)) {
        const targetIdx = newType.targetProfile?.indexOf(targetType.targetProfile[0]);
        if (targetIdx != null && targetIdx > -1) {
          newType.targetProfile.splice(targetIdx, 1, ...matchedTargetProfiles);
        } else {
          newType.targetProfile = newType.profile ?? [];
          newType.targetProfile.push(...matchedTargetProfiles);
        }
      }
      if (!isEmpty(matchedProfiles)) {
        const targetIdx = newType.profile?.indexOf(targetType.profile[0]);
        if (targetIdx != null && targetIdx > -1) {
          newType.profile.splice(targetIdx, 1, ...matchedProfiles);
        } else {
          newType.profile = newType.profile ?? [];
          newType.profile.push(...matchedProfiles);
        }
      }
    } else {
      if (!isEmpty(matchedTargetProfiles)) {
        newType.targetProfile = matchedTargetProfiles;
      }
      if (!isEmpty(matchedProfiles)) {
        newType.profile = matchedProfiles;
      }
    }
  }

  private findTypeIntersection(
    leftTypes: ElementDefinitionType[],
    rightTypes: ElementDefinitionType[],
    targetType: ElementDefinitionType,
    fisher: Fishable
  ): ElementDefinitionType[] {
    const intersection: ElementDefinitionType[] = [];
    let match: ElementTypeMatchInfo;
    leftTypes.forEach(left => {
      // if the left type has profiles, check each of them.
      // otherwise, just try with the code.
      const matches: ElementTypeMatchInfo[] = [];
      const typesToTry = left.profile?.length ? left.profile : [left.code];
      typesToTry.forEach(typeToTry => {
        try {
          match = this.findTypeMatch({ type: typeToTry }, rightTypes, fisher);
          matches.push(match);
        } catch {
          // it's okay if a given type doesn't have any matches.
        }
      });
      intersection.push(...this.applyTypeIntersection(left, targetType, matches));
    });

    return intersection;
  }

  // In the case of an element type whose code is a supertype (e.g., 'Resource'), we need to
  // break that up into a new set of element types corresponding to the subtypes.  For example,
  // if a 'Resource' type is constrained to 'Condition' and 'Procedure', then in the resulting
  // StructureDefinition, there should be element types with codes 'Condition' and 'Procedure',
  // and no element type with the code 'Resource` any longer.  So... we create a special
  // map to store the current subtypes (or if not applicable, just store the original type).
  private applyTypeIntersection(
    type: ElementDefinitionType,
    targetType: ElementDefinitionType,
    matches: ElementTypeMatchInfo[]
  ) {
    const intersection: ElementDefinitionType[] = [];
    const currentTypeMatches: Map<string, ElementTypeMatchInfo[]> = new Map();
    const fhirPathPrimitive = /^http:\/\/hl7\.org\/fhirpath\/System\./;
    for (const match of matches) {
      // If the original element type is a Reference/canonical, keep it as is, otherwise take on the
      // input type's type code (as represented in its StructureDefinition.type).
      const typeString =
        isReferenceType(match.code) || match.code === 'canonical'
          ? match.code
          : match.metadata.sdType;
      if (!currentTypeMatches.has(typeString)) {
        currentTypeMatches.set(typeString, []);
      }
      currentTypeMatches.get(typeString).push(match);
    }
    for (const [typeCode, currentMatches] of currentTypeMatches) {
      const newType = cloneDeep(type);
      // never change the code of a FHIRPath primitive
      if (!fhirPathPrimitive.test(type.getActualCode())) {
        newType.code = typeCode;
      }
      this.applyProfiles(newType, targetType, currentMatches);
      intersection.push(newType);
    }
    return intersection;
  }

  /**
   * Sets flags on this element as specified in a profile or extension.
   * Don't change a flag when the incoming argument is undefined or false.
   * @see {@link http://hl7.org/fhir/R4/profiling.html#mustsupport}
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.mustSupport}
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.isSummary}
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.isModifier}
   * @see {@link http://hl7.org/fhir/R4/versions.html#std-process}
   * @see {@link http://hl7.org/fhir/extension-structuredefinition-standards-status.html}
   * @see {@link http://hl7.org/fhir/valueset-standards-status.html}
   * @param mustSupport - whether to make this element a Must Support element
   * @param summary - whether to include this element when querying for a summary
   * @param modifier - whether this element acts as a modifier on the resource
   * @param trialUse - indicates a standards status of "Trial Use" for this element
   * @param normative - indicates a standards status of "Normative" for this element
   * @param draft - indicates a standards status of "Draft" for this element
   */
  applyFlags(
    mustSupport: boolean,
    summary: boolean,
    modifier: boolean,
    trialUse: boolean,
    normative: boolean,
    draft: boolean
  ): void {
    let newStatusExtension: any = null;
    if (trialUse) {
      newStatusExtension = {
        url: 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
        valueCode: 'trial-use'
      };
    }
    if (normative) {
      if (newStatusExtension) {
        throw new MultipleStandardsStatusError(this.id);
      }
      newStatusExtension = {
        url: 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
        valueCode: 'normative'
      };
    }
    if (draft) {
      if (newStatusExtension) {
        throw new MultipleStandardsStatusError(this.id);
      }
      newStatusExtension = {
        url: 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
        valueCode: 'draft'
      };
    }

    const connectedElements = this.findConnectedElements();
    if (mustSupport === true) {
      if (this.structDef.derivation === 'specialization') {
        // MustSupport is only allowed in profiles
        throw new InvalidMustSupportError(this.structDef.name, this.id);
      }

      this.mustSupport = mustSupport;
      // MS only gets applied to connected elements that are not themselves slices,
      // unless they're the same slice name as this.
      // For example, Observation.component.interpretation MS implies Observation.component:Lab.interpretation MS
      // And Observation.component.extension:Sequel MS implies Observation.component:Lab.extension:Sequel
      // But Observation.component MS does not imply Observation.component:Lab MS
      connectedElements
        .filter(ce => ce.sliceName == null || ce.sliceName == this.sliceName)
        .forEach(ce => (ce.mustSupport = mustSupport || ce.mustSupport));
    }
    if (summary === true) {
      this.isSummary = summary;
      connectedElements.forEach(ce => (ce.isSummary = summary));
    }
    if (modifier === true) {
      this.isModifier = modifier;
      connectedElements.forEach(ce => (ce.isModifier = modifier || ce.isModifier));
    }
    if (newStatusExtension) {
      if (this.extension) {
        const oldStatus = this.extension.findIndex(
          extension =>
            extension.url ==
            'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
        );
        if (oldStatus > -1) {
          this.extension[oldStatus] = newStatusExtension;
        } else {
          this.extension.push(newStatusExtension);
        }
      } else {
        this.extension = [newStatusExtension];
      }
    }
  }

  /**
   * Binds a value set with a specific strength to this element.  The type must be coded (code, Coding,
   * CodeableConcept, Quantity), or the data types (string, uri).  The strength must be the same or
   * stricter than the current strength (if a binding already exists).
   * TODO: Determine if it is valid to bind value set on a choice element (e.g., value[x]).
   * TODO: Determine rules for replacing existing bindings when we can't guarantee rules are followed.
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.binding}
   * @see {@link http://hl7.org/fhir/R4/terminologies.html#strength}
   * @param {string} vsURI - the value set URI to bind
   * @param {string} strength - the strength of the binding (e.g., 'required')
   * @param {SourceInfo} - optionally include rule.sourceInfo if the binding is coming from a rule
   * @throws {BindingStrengthError} when the binding can't be applied because it is looser than the existing binding
   * @throws {CodedTypeNotFoundError} - when the binding can't be applied because the element is the wrong type
   * @throws {InvalidUriError} when the value set uri is not valid
   */
  bindToVS(
    vsURI: string,
    strength: ElementDefinitionBindingStrength,
    ruleSourceInfo?: SourceInfo,
    fisher?: Fishable
  ): void {
    // Check if this is a valid type to be bound against
    const validTypes = this.findTypesByCode(
      'code',
      'Coding',
      'CodeableConcept',
      'CodeableReference',
      'Quantity',
      'string',
      'uri'
    );
    const isBindable =
      validTypes.length ||
      this.type?.some(type => fisher?.fishForMetadata(type.code, Type.Logical)?.canBind);
    if (!isBindable) {
      if (this.type?.some(type => fisher?.fishForMetadata(type.code, Type.Logical) != null)) {
        // Only warn if it was from a logical model that doesn't have #can-bind characteristic
        logger.warn(
          `Bindings can only be applied to logical model types with the #can-bind characteristic. Update the target logical model to declare the #can-bind characteristic or remove the binding from ${this.id}.`,
          ruleSourceInfo
        );
      } else {
        throw new CodedTypeNotFoundError(this.type ? this.type.map(t => t.code) : []);
      }
    }
    // Check if a CodeableReference is attempting to bind directly to the concept element
    if (
      this.type.length === 1 &&
      this.type[0].code === 'CodeableConcept' &&
      this.path.endsWith('.concept') &&
      this.parent()?.type?.[0]?.code === 'CodeableReference'
    ) {
      logger.error(
        "Applying value set bindings to a CodeableReference element's underlying .concept path is not allowed. Instead, apply the binding directly to the CodeableReference element.",
        ruleSourceInfo
      );
    }
    const strengths = ['example', 'preferred', 'extensible', 'required'];
    // Check if this is a valid strength (if the binding.strength already exists)
    if (this.binding && this.binding.strength) {
      if (strengths.indexOf(strength) < strengths.indexOf(this.binding.strength)) {
        throw new BindingStrengthError(this.binding.strength, strength);
      }
    }

    const connectedElements = this.findConnectedElements();
    connectedElements.forEach(ce => {
      if (vsURI == ce.binding?.valueSet) {
        try {
          ce.bindToVS(vsURI, strength, null, fisher);
        } catch {
          // receiving a BindingStrengthError on a slice is not a problem, because
          // it is fine if the slice has a stronger binding than the list element.
        }
      }
    });
    // check to make sure we are not applying an explicitly weaker binding of the same value set of a slice's list element
    const listElement = this.slicedElement();
    if (
      listElement?.binding?.valueSet == vsURI &&
      strengths.indexOf(strength) < strengths.indexOf(listElement?.binding?.strength)
    ) {
      throw new BindingStrengthError(listElement?.binding?.strength, strength);
    }

    if (vsURI == null) {
      // Just bind the strength since valueSet is allowed to be 0..1
      this.binding = { strength };
    } else {
      // Canonical URLs may include | to specify version: https://www.hl7.org/fhir/references.html#canonical
      // The URI may be a fragment starting with #
      if (!isUri(vsURI.split('|')[0]) && !vsURI.startsWith('#')) {
        throw new InvalidUriError(vsURI);
      }

      // We're good.  Bind it.
      this.binding = {
        strength,
        valueSet: vsURI
      };
    }
  }

  /**
   * Assigns a value to an ElementDefinition
   * @param {AssignmentValueType} value - The value to assign
   * @param {exactly} boolean - True if if fixed[x] should be used, otherwise pattern[x] is used
   * @throws {NoSingleTypeError} when the ElementDefinition does not have a single type
   * @throws {ValueAlreadyAssignedError} when the value is already assigned to a different value
   * @throws {MismatchedTypeError} when the value does not match the type of the ElementDefinition
   */
  assignValue(value: AssignmentValueType, exactly = false, fisher?: Fishable, rawValue: any = null): void {
    let type: string;
    if (value instanceof FshCode) {
      type = 'Code';
    } else if (value instanceof FshQuantity) {
      type = 'Quantity';
    } else if (value instanceof FshRatio) {
      type = 'Ratio';
    } else if (value instanceof FshReference) {
      type = 'Reference';
    } else if (value instanceof FshCanonical) {
      type = 'Canonical';
    } else if (value instanceof InstanceDefinition) {
      type = 'InstanceDefinition';
    } else if (typeof value === 'bigint') {
      type = 'number';
    } else {
      type = typeof value;
    }

    // We can only assign elements that have a single type, else it is ambiguous
    if (!this.hasSingleType()) {
      throw new NoSingleTypeError(type);
    }

    // If assigning by pattern, ensure that it's not already assigned by fixed[x], because We can't override
    // fixed[x] with pattern[x] since pattern[x] is looser
    if (!exactly) {
      const fixedField = Object.entries(this).find(e => e[0].startsWith('fixed') && e[1] != null);
      if (fixedField) {
        throw new FixedToPatternError(fixedField[0]);
      }
    }

    // The approach to assigning may differ based on type...
    switch (type) {
      case 'boolean':
        this.assignFHIRValue(value.toString(), value, exactly, 'boolean');
        break;
      case 'number':
        this.assignNumber(value as number, exactly, rawValue);
        break;
      case 'string':
        this.assignString(value as string, exactly);
        break;
      case 'Code':
        this.assignFshCode(value as FshCode, exactly, fisher);
        break;
      case 'Quantity':
        value = value as FshQuantity;
        // Special case quantity to support compatible specializations (like Age), but try to do it
        // in a flexible way (without hard-coding every specialization here).
        let providedType = 'Quantity';
        const actualType = this.type[0].code;
        if (actualType !== 'Quantity') {
          const actualTypeSD = fisher?.fishForFHIR(actualType, Type.Type);
          if (actualTypeSD?.baseDefinition === 'http://hl7.org/fhir/StructureDefinition/Quantity') {
            // We treat every quantity instance as compatible w/ every specialization. This is not
            // strictly true, but in order to validate it, we'd need to either support/process the
            // FHIRPath rules or hard-code a bunch of special case logic here. Instead, let the IG
            // Publisher deal with this extra validation and just pass it through here.
            providedType = actualType;
          }
        }
        this.assignFHIRValue(value.toString(), value.toFHIRQuantity(), exactly, providedType);
        break;
      case 'Ratio':
        value = value as FshRatio;
        this.assignFHIRValue(value.toString(), value.toFHIRRatio(), exactly, 'Ratio');
        break;
      case 'Reference':
        value = value as FshReference;

        // It is possible the reference constraints do not come from the current element itself, so find the
        // element which is constraining the current element, and check the assignment against it
        const referenceConstrainingElement =
          this.type[0].code === 'Reference' &&
          this.parent()?.type?.[0]?.code === 'CodeableReference'
            ? this.parent()
            : this;
        if (
          !referenceConstrainingElement.typeSatisfiesTargetProfile(
            value.sdType,
            value.sourceInfo,
            fisher
          )
        ) {
          throw new InvalidTypeError(
            `Reference(${value.sdType})`,
            referenceConstrainingElement.type
          );
        }
        if (this.type[0].code === 'CodeableReference') {
          // If we are assigning to a CodeableReference, we assign a value of a complex object containing the reference.
          // If there's already a coding on the element, we want to keep it.
          const existing =
            this.fixedCodeableReference ??
            this.patternCodeableReference ??
            this.assignedByAnyParent();
          const codeableReference: CodeableReference = { reference: value.toFHIRReference() };
          if (existing?.concept != null) {
            codeableReference.concept = existing.concept;
          }
          this.assignFHIRValue(value.toString(), codeableReference, exactly, 'CodeableReference');
        } else {
          this.assignFHIRValue(value.toString(), value.toFHIRReference(), exactly, 'Reference');
        }

        break;
      case 'Canonical':
        value = value as FshCanonical;
        // Get the canonical url of the entity
        let canonicalDefinition = fisher.fishForMetadata(
          value.entityName,
          Type.Resource,
          Type.Logical,
          Type.Type,
          Type.Profile,
          Type.Extension,
          Type.ValueSet,
          Type.CodeSystem,
          Type.Instance
        );
        let canonicalUrl: string;
        if (
          !this.typeSatisfiesTargetProfile(
            canonicalDefinition?.resourceType,
            value.sourceInfo,
            fisher
          )
        ) {
          // The first fishing result didn't work. Now check all results in case the fishing matches multiple results.
          const allMatchingMetadatas = fisher.fishForMetadatas(
            value.entityName,
            Type.Resource,
            Type.Logical,
            Type.Type,
            Type.Profile,
            Type.Extension,
            Type.ValueSet,
            Type.CodeSystem,
            Type.Instance
          );
          const otherCanonicalDefinition = allMatchingMetadatas.find(md =>
            this.typeSatisfiesTargetProfile(
              md?.resourceType,
              (value as FshCanonical).sourceInfo,
              fisher
            )
          );
          if (otherCanonicalDefinition) {
            canonicalDefinition = otherCanonicalDefinition;
          } else {
            throw new InvalidTypeError(`Canonical(${canonicalDefinition.resourceType})`, this.type);
          }
        }
        if (canonicalDefinition?.url) {
          canonicalUrl = canonicalDefinition.url;
        } else if (canonicalDefinition?.id && canonicalDefinition.instanceUsage === 'Inline') {
          canonicalUrl = `#${canonicalDefinition.id}`;
        } else {
          throw new InvalidCanonicalUrlError(value.entityName);
        }
        if (value.version) {
          canonicalUrl += `|${value.version}`;
        }
        this.assignString(canonicalUrl, exactly);
        break;
      case 'InstanceDefinition':
        value = value as InstanceDefinition;
        const stringVal = JSON.stringify(value);
        this.assignFHIRValue(
          stringVal,
          value.toJSON(),
          exactly,
          value._instanceMeta.sdType ?? value.resourceType,
          fisher
        );
        break;
      default:
        type = (typeof value === 'object' && value.constructor?.name) ?? type;
        throw new MismatchedTypeError(type, value, this.type[0].code);
    }

    // If the element is found in a discriminator.path, then we enforce that it has minimum cardinality 1
    // since its value is assigned. It has to be there, otherwise it's not that slice. The one exception
    // is if you are fixing the value of the sliced element itself (e.g., discriminator path is $this),
    // in which case we don't want to force the whole slice to be required.
    const parentSlices = [this, ...this.getAllParents().reverse()].filter(el => el.sliceName);
    parentSlices.forEach(parentSlice => {
      const slicedElement = parentSlice.slicedElement();
      if (
        slicedElement.slicing.discriminator?.some(
          d =>
            d.path !== '$this' &&
            `${slicedElement.path}.${d.path}` === this.path &&
            ['value', 'pattern'].includes(d.type)
        ) &&
        this.min === 0
      ) {
        this.constrainCardinality(1, '');
      }
    });
  }

  /**
   * Checks if a FHIR value can be assigned and then assigns it if so. A FHIR value can be assigned on an element if:
   * - the element isn't already assigned to something else (by fixed[x], pattern[x], or from a parent)
   * - or the element is already assigned to something that is the same or a subset of the new value
   *   - e.g., you can assign { code: 'Foo', system: 'http://bar.com' } to an element already assigned to
   *     { system: 'http://bar.com } because the new value contains the old value (with no conflicts).
   *     This does not work the other way around, however.
   * @param {string} fshValue - The FSH-syntax-formatted value (usually the FSH class .toString())
   * @param {object} fhirValue - The FHIR representation of the FSH value
   * @param {boolean} exactly - Set to true if fixed[x] should be used, otherwise pattern[x] is used
   * @param {string} type - The FHIR type that is being assigned; will be used to construct fixed[x] and pattern[x] names
   * @throws {ValueAlreadyAssignedError} when the currentElementValue exists and is different than the new value
   * @throws {MismatchedTypeError} when the value does not match the type of the ElementDefinition
   */
  private assignFHIRValue(
    fshValue: string,
    fhirValue: any,
    exactly: boolean,
    type: string,
    fisher?: Fishable
  ) {
    const lineage = fisher ? this.getTypeLineage(type, fisher).map(meta => meta.sdType) : [];
    if (!this.type.some(t => t.code === type || lineage.includes(t.code))) {
      throw new MismatchedTypeError(type, fshValue, this.type[0].code);
    }

    // Find the fixed[x] and pattern[x] variables to use
    const fixedX = `fixed${upperFirst(type)}` as keyof ElementDefinition;
    const patternX = `pattern${upperFirst(type)}` as keyof ElementDefinition;

    // Find any currently assigned values
    const currentElementValue = this[fixedX] ?? this[patternX] ?? this.assignedByAnyParent();
    // For complex types, use isMatch to check if they are a subset, otherwise use isEqual
    const compareFn = typeof fhirValue === 'object' ? isMatch : isEqual;
    if (
      currentElementValue != null &&
      !Array.isArray(currentElementValue) &&
      !compareFn(fhirValue, currentElementValue)
    ) {
      // It's a different value and not a compatible subset (e.g., the new value doesn't contain the old)
      throw new ValueAlreadyAssignedError(fshValue, type, JSON.stringify(currentElementValue));
    }

    // Children of elements with complex types such as Quantity may already have assigned values
    this.checkAssignedValueAgainstChildren(this, fhirValue);

    // if this is a slice, make sure that nothing on this.slicedElement() is being violated
    const slicedElement = this.slicedElement();
    if (slicedElement) {
      slicedElement.checkAssignedValueAgainstChildren(slicedElement, fhirValue);
    }

    // If we made it this far, assign the value using fixed[x] or pattern[x] as appropriate
    if (exactly) {
      // @ts-ignore: Type 'any' is not assignable to type 'never'
      this[fixedX] = fhirValue;
      delete this[patternX];
    } else {
      // @ts-ignore: Type 'any' is not assignable to type 'never'
      this[patternX] = fhirValue;
      // NOTE: No need to delete fixed[x], as changing from fixed[x] to pattern[x] is not allowed
    }
  }

  private checkAssignedValueAgainstChildren(currentChild: ElementDefinition, fhirValue: any) {
    const directChildren = currentChild.children(true);

    let i = 0;
    while (i < directChildren.length) {
      const child = directChildren[i];

      this.checkAssignedValueAgainstChild(child, fhirValue);
      this.checkAssignedValueAgainstChildren(child, fhirValue);

      // If the slicing is closed, only throw an error if all slices conflict
      if (child.slicing?.rules === 'closed') {
        let numInvalid = 0;
        child.getSlices().forEach(slice => {
          try {
            this.checkAssignedValueAgainstChild(slice, fhirValue);
            this.checkAssignedValueAgainstChildren(slice, fhirValue);
          } catch {
            numInvalid += 1;
          }
        });
        if (numInvalid >= child.getSlices().length) {
          throw new ValueConflictsWithClosedSlicingError(JSON.stringify(fhirValue));
        }
      }

      // If there is any slicing, skip past the slices. Closed slices are handled above
      // And open slices need not be validated against
      i += child.slicing ? child.getSlices().length + 1 : 1;
    }
  }

  private checkAssignedValueAgainstChild(child: ElementDefinition, fhirValue: any) {
    const childType = child.type[0].code;
    const fixedX = `fixed${upperFirst(childType)}` as keyof ElementDefinition;
    const patternX = `pattern${upperFirst(childType)}` as keyof ElementDefinition;
    const currentChildValue = child[fixedX] ?? child[patternX];
    if (currentChildValue != null) {
      // find the element on fhirValue that would get assigned to the child.
      // sometimes, there may be arrays inside complex object types, such as CodeableConcept.
      // therefore, flatten those arrays as the path is traversed so that all possible new values are found.
      const childPath = child.path.replace(`${this.path}.`, '').split('.');
      let newChildValue = [fhirValue];
      for (const pathPart of childPath) {
        newChildValue = flatten(
          newChildValue.map(value => {
            return value?.[pathPart];
          })
        );
      }
      newChildValue.forEach(value => {
        if (value != null) {
          const childCompareFn = typeof value === 'object' ? isMatch : isEqual;
          if (!childCompareFn(value, currentChildValue as object)) {
            throw new ValueAlreadyAssignedError(
              value,
              childType,
              JSON.stringify(currentChildValue)
            );
          }
        }
      });
    }
  }

  /**
   * @param sdType - The type to check
   * @param sourceInfo - Source information for logging purposes
   * @param fisher - A fishable implementation for finding definitions and metadata
   * @returns - False if the type does not satisfy the targetProfile, true otherwise (or if it can't be determined)
   */
  private typeSatisfiesTargetProfile(
    sdType: string,
    sourceInfo: SourceInfo,
    fisher: Fishable
  ): boolean {
    // If no targetProfile is present, there is nothing to check the value against, so just allow it
    if (sdType && this.type[0].targetProfile) {
      const validTypes: string[] = [];
      this.type[0].targetProfile.forEach(tp => {
        // target profile may have a version after a | character.
        // fish for matching version, but fall back to any version if necessary.
        const tpType = fishForMetadataBestVersion(fisher, tp, sourceInfo)?.sdType;
        if (tpType) {
          validTypes.push(tpType);
        }
      });

      const typeLineage = this.getTypeLineage(sdType, fisher);
      if (!typeLineage.some(md => validTypes.includes(md.sdType))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if an element is assigned by a fixed[x] or pattern[x] on its direct parent
   * @returns {any} the value the element is assigned to by its parent, undefined if value is not assigned
   */
  assignedByDirectParent(): any {
    const parent = this.parent();
    const assignedKey = parent
      ? Object.keys(parent).find(k => k.startsWith('fixed') || k.startsWith('pattern'))
      : null;
    if (assignedKey) {
      const assignedValue: any = parent[assignedKey as keyof ElementDefinition];
      return assignedValue[this.path.replace(`${parent.path}.`, '')];
    }
  }

  /**
   * Checks if an element is assigned by a pattern[x] on any of its parents
   * @returns {any} the value the element is assigned to by its parent, undefined if value is not assigned
   */
  assignedByAnyParent(): any {
    const parent = this.parent();
    if (parent == null) {
      return;
    } else {
      let assignedValue = this.assignedByDirectParent();
      if (assignedValue == null) {
        // Get the value from the parent, and index into that value
        const parentValue = parent.assignedByAnyParent();
        const childIndex = this.path.replace(`${parent.path}.`, '');
        if (Array.isArray(parentValue)) {
          // If the value is an array, there are two cases
          // 1 - All the assigned values in the array match => return the value
          // 2 - The assigned values in the array don't match => return [val1, val2]
          // since values do exist, but they conflict so no value should be allowed to be set
          // and for any value [val1, val2] != value
          assignedValue =
            parentValue.every(pv => pv[childIndex] === parentValue[0][childIndex]) &&
            parentValue.length > 0
              ? parentValue[0][childIndex]
              : parentValue.map(pv => pv[childIndex]);
        } else {
          assignedValue = parentValue?.[childIndex];
        }
      }
      return assignedValue;
    }
  }

  /**
   * Assigns a number to this element.
   * @see {@link assignValue}
   * @see {@link https://www.hl7.org/fhir/datatypes.html#primitive}
   * @param {number} value - the number value to assign
   * @param {exactly} boolean - True if if fixed[x] should be used, otherwise pattern[x] is used
   * @throws {NoSingleTypeError} when the ElementDefinition does not have a single type
   * @throws {ValueAlreadyAssignedError} when the value is already assigned to a different value
   * @throws {MismatchedTypeError} when the value does not match the type of the ElementDefinition
   */
  private assignNumber(value: number | bigint, exactly = false, rawValue: any = null): void {
    const type = this.type[0].code;
    const valueAsNumber = Number(value);
    // In case of 
    if (type === 'decimal' && !isNaN(Number(rawValue)) && /^\d+\.0+$/.test(rawValue)) {
      this.assignFHIRValue(rawValue.toString(), rawValue.toString(), exactly, type);
    } else if (
        type === 'decimal' ||
        (type === 'integer' && Number.isInteger(valueAsNumber)) ||
        (type === 'unsignedInt' && Number.isInteger(valueAsNumber) && valueAsNumber >= 0) ||
        (type === 'positiveInt' && Number.isInteger(valueAsNumber) && valueAsNumber > 0)
    ) {
      this.assignFHIRValue(value.toString(), valueAsNumber, exactly, type);
    } else if (type === 'integer64' && typeof value === 'bigint') {
      // integer64 is dealt with separately, since it is represented as a string in FHIR
      // see: http://hl7.org/fhir/2020Sep/datatypes.html#integer64
      this.assignFHIRValue(value.toString(), value.toString(), exactly, type);
    } else {
      throw new MismatchedTypeError('number', value, type);
    }
  }

  private isValidBase64(value: string): boolean {
    const base64Part = /(\s*([0-9a-zA-Z\+\/=]){4}\s*)/y;
    while (base64Part.lastIndex < value.length) {
      if (!base64Part.test(value)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Assigns a string to this element.
   * @see {@link assignValue}
   * @see {@link https://www.hl7.org/fhir/datatypes.html#primitive}
   * @param {string} value - the string value to assign
   * @param {exactly} boolean - True if if fixed[x] should be used, otherwise pattern[x] is used
   * @throws {NoSingleTypeError} when the ElementDefinition does not have a single type
   * @throws {ValueAlreadyAssignedError} when the value is already assigned to a different value
   * @throws {TypeNotFoundError} when the value does not match the type of the ElementDefinition
   */
  private assignString(value: string, exactly = false): void {
    const type = this.type[0].code;
    if (
      type === 'string' ||
      (type === 'uri' && /^\S*$/.test(value)) ||
      (type === 'url' && /^\S*$/.test(value)) ||
      (type === 'canonical' && /^\S*$/.test(value)) ||
      (type === 'base64Binary' && (this.isValidBase64(value) || value.startsWith('ig-loader-'))) ||
      (type === 'instant' &&
        /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/.test(
          value
        )) ||
      (type === 'date' &&
        /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?$/.test(
          value
        )) ||
      (type === 'dateTime' &&
        /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/.test(
          value
        )) ||
      (type === 'time' &&
        /^([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?$/.test(value)) ||
      (type === 'oid' && /^urn:oid:[0-2](\.(0|[1-9][0-9]*))+$/.test(value)) ||
      (type === 'id' && /^[A-Za-z0-9\-\.]{1,64}$/.test(value)) ||
      (type === 'markdown' && /^\s*(\S|\s)*$/.test(value)) ||
      type === 'uuid' ||
      (type === 'integer64' && /^[-]?\d+$/.test(value))
    ) {
      this.assignFHIRValue(`"${value}"`, value, exactly, type);
    } else if (type == 'xhtml' && this.checkXhtml(value)) {
      this.assignFHIRValue(`"${value}"`, value, exactly, type);
      // If we got here, the assigned value is valid. Replace the XML with a minimized version.
      // For minimizer options, see: https://www.npmjs.com/package/html-minifier#options-quick-reference
      this[exactly ? 'fixedXhtml' : 'patternXhtml'] = minify(value, {
        collapseWhitespace: true,
        html5: false,
        keepClosingSlash: true
      });
    } else {
      throw new MismatchedTypeError('string', value, type);
    }
  }

  private checkXhtml(value: string): boolean {
    try {
      if (this.path.endsWith('.div')) {
        const startsWithDiv = /^\s*<\s*div[\s>]/.test(value);
        const endsWithDiv = /<\s*\/\s*div\s*>\s*$/.test(value);
        if (!startsWithDiv || !endsWithDiv) {
          logger.warn(`xhtml div elements should start and end with <div> tags for ${this.id}`);
        }
      }
      return sax.parser(true).write(value).error == null;
    } catch {
      return false;
    }
  }

  /**
   * Checks if a resource can be assigned to this element
   * @param {InstanceDefinition} value - The resource to assign
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @throws {MismatchedTypeError} when the ElementDefinition is not of type Resource
   * @returns {InstanceDefinition} the input value when it can be assigned
   */
  checkAssignInlineInstance(value: InstanceDefinition, fisher: Fishable): InstanceDefinition {
    const inlineInstanceType = value.resourceType ?? value._instanceMeta.sdType;
    const lineage = this.getTypeLineage(inlineInstanceType, fisher).map(
      metadata => metadata.sdType
    );
    if (this.type?.some(t => lineage.includes(t.code))) {
      // capture original value to restore after assignment
      const originalKey = Object.keys(this).find(
        k => k.startsWith('pattern') || k.startsWith('fixed')
      ) as keyof ElementDefinition;
      const originalValue = this[originalKey];
      // try assigning it to test for value conflicts
      const stringVal = JSON.stringify(value);
      this.assignFHIRValue(
        stringVal,
        value.toJSON(),
        true,
        value._instanceMeta.sdType ?? value.resourceType,
        fisher
      );
      // if the assignment is successful, undo it and return the value
      const key = Object.keys(this).find(
        k => k.startsWith('pattern') || k.startsWith('fixed')
      ) as keyof ElementDefinition;
      if (key != null) {
        delete this[key];
        // @ts-ignore
        this[originalKey] = originalValue;
      }
      return value;
    } else {
      // In this case neither the type of the inline instance nor the type of any of its parents matches the
      // ED.type, so we cannot assign the inline instance to this ED.
      throw new MismatchedTypeError(
        inlineInstanceType,
        value._instanceMeta.name ?? value.id,
        this.type?.map(t => t.code).join(', ')
      );
    }
  }

  /**
   * Assigns a code to this element, formatting it in the way the element expects for the type.
   * If the element is not a code-ish type or a different code is already assigned, it will throw.
   * TODO: Determine if it is valid to assign the code on a choice element (e.g., value[x]).
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.fixed_x_}
   * @see {@link http://hl7.org/fhir/R4/elementdefinition-definitions.html#ElementDefinition.pattern_x_}
   * @param {FshCode} code - the code to assign
   * @param {boolean} exactly - True if if fixed[x] should be used, otherwise pattern[x] is used
   * @param {Fishable} fisher - A fishable object used for finding structure definitions
   * @throws {MismatchedTypeError} when the type of the value cannot be assigned to the element
   * @throws {ValueAlreadyAssignedError} when the code is already assigned to a different code
   * @throws {InvalidUriError} when the system being assigned is not a valid uri
   */
  private assignFshCode(code: FshCode, exactly = false, fisher?: Fishable): void {
    const type = this.type[0].code;

    if (code.system) {
      const csURI = code.system.split('|')[0];
      const vsURI =
        fishForMetadataBestVersion(fisher, code.system, code.sourceInfo, Type.ValueSet)?.url ?? '';
      if (vsURI) {
        if (type === 'code' || type === 'string' || type === 'uri') {
          logger.warn(
            `The fully qualified code ${code.system}#${code.code} is invalid because the specified system is a ValueSet. ` +
              `Since ${this.path} is a ${type}, the system will not be used, but this issue should be corrected by ` +
              `updating the system to refer to a proper CodeSystem or by specifying a code only (e.g., #${code.code}).`
          );
        } else {
          throw new MismatchedBindingTypeError(code.system, this.path, 'CodeSystem');
        }
      } else if (!isUri(csURI)) {
        if (type === 'code' || type === 'string' || type === 'uri') {
          logger.warn(
            `The fully qualified code ${code.system}#${code.code} is invalid because the specified system is not a URI. ` +
              `Since ${this.path} is a ${type}, the system will not be used, but this issue should be corrected by ` +
              `updating the system to refer to a proper CodeSystem or by specifying a code only (e.g., #${code.code}).`
          );
        } else {
          throw new InvalidUriError(code.system);
        }
      }
    }

    if (type === 'code' || type === 'string' || type === 'uri') {
      this.assignFHIRValue(code.toString(), code.code, exactly, type);
    } else if (type === 'CodeableConcept') {
      this.assignFHIRValue(
        code.toString(),
        code.toFHIRCodeableConcept(),
        exactly,
        'CodeableConcept'
      );
    } else if (type === 'Coding') {
      this.assignFHIRValue(code.toString(), code.toFHIRCoding(), exactly, 'Coding');
    } else if (this.isQuantityType(type, fisher)) {
      // Since code only maps to part of Quantity, we want to ensure that if there are other (non-code) parts
      // already assigned, we take them on too -- as we don't want to overwrite them with blanks.
      const existing = this.fixedQuantity ?? this.patternQuantity ?? this.assignedByAnyParent();
      const quantity = code.toFHIRQuantity();
      if (existing?.value != null) {
        quantity.value = existing.value;
      }
      if (existing?.comparator != null) {
        quantity.comparator = existing.comparator;
      }
      this.assignFHIRValue(code.toString(), quantity, exactly, type);
    } else if (type === 'CodeableReference') {
      // Similar to Quantity, we want to ensure that if a reference already exists, we keep it.
      const existing =
        this.fixedCodeableReference ?? this.patternCodeableReference ?? this.assignedByAnyParent();
      const codeableReference: CodeableReference = { concept: code.toFHIRCodeableConcept() };
      if (existing?.reference != null) {
        codeableReference.reference = existing.reference;
      }
      this.assignFHIRValue(code.toString(), codeableReference, exactly, 'CodeableReference');
    } else {
      throw new MismatchedTypeError('code', code, type);
    }
  }

  /**
   * Checks if a provided type is a specialization of Quantity
   * @param {string} type - The type being checked
   * @param {Fishable} fisher - A fishable object used for finding the Base Definition of the provided type
   */
  private isQuantityType(type: string, fisher?: Fishable): boolean {
    if (type === 'Quantity') {
      return true;
    }
    const actualTypeSD = fisher?.fishForFHIR(type, Type.Type);
    return actualTypeSD?.baseDefinition === 'http://hl7.org/fhir/StructureDefinition/Quantity';
  }

  /**
   * Checks if a the ElementDefinition has exactly one type
   * @returns {boolean} - true if there is exactly one type
   */
  private hasSingleType() {
    const types = this.type ?? [];
    return types.length === 1;
  }

  /**
   * Sets mapping on an element
   * @see {@link https://www.hl7.org/fhir/elementdefinition-definitions.html#ElementDefinition.mapping}
   * @param {string} identity - value for mapping.identity
   * @param {string} map - value for mapping.map
   * @param {string} comment - value for mapping.comment
   * @param {FshCode} language - language.code is value for mapping.language
   * @throws {InvalidMappingError} when attempting to set mapping with identity or map undefined
   * @throws {InvalidFHIRIdError} when setting mapping.identity to an invalid FHIR ID
   */
  applyMapping(identity: string, map: string, comment: string, language: FshCode): void {
    if (identity == null || map == null) {
      throw new InvalidMappingError();
    }
    if (!idRegex.test(identity)) {
      throw new InvalidFHIRIdError(identity);
    }
    const mapping = {
      identity,
      map,
      ...(comment && { comment }),
      ...(language && { language: language.code })
    };
    if (this.mapping) {
      this.mapping.push(mapping);
    } else {
      this.mapping = [mapping];
    }
  }

  /**
   * Finds and returns the parent element.  For example, the parent element of `Foo.bar.one` is the element `Foo.bar`.
   * @returns {ElementDefinition|undefined} the parent element or undefined if this is the root element
   */
  parent(): ElementDefinition | undefined {
    if (!this.treeParent) {
      const parentId = this.id.slice(0, this.id.lastIndexOf('.'));
      if (parentId !== '' && this.structDef) {
        this.treeParent = this.structDef.findElement(parentId);
      } else if (!this.structDef) {
        this.treeParent = undefined;
      }
    }
    return this.treeParent;
  }

  /**
   * Finds and returns all parent elements.  For example, the parent elements of `Foo.bar.one` are [`Foo.bar`, `Foo`].
   * @returns {ElementDefinition[]} the array of parents, empty if no parents
   */
  getAllParents(): ElementDefinition[] {
    const parents = [];
    let parent = this.parent();
    while (parent) {
      parents.push(parent);
      parent = parent.parent();
    }
    return parents;
  }

  /**
   * Finds and returns all child elements of this element.  For example, the children of `Foo.bar` might be the
   * elements `Foo.bar.one`, `Foo.bar.two`, and `Foo.bar.two.a`.  This will not "expand" or "unroll" elements; it
   * only returns those child elements that already exist in the structure definition.
   * @param {boolean} directOnly - If true, only direct children of the element are returned
   * @returns {ElementDefinition[]} the child elements of this element
   */
  children(directOnly = false): ElementDefinition[] {
    if (!this.treeChildren) {
      this.treeChildren = this.structDef.elements.filter(e => {
        return (
          e !== this &&
          e.id.startsWith(`${this.id}.`) &&
          e.path.split('.').length === this.path.split('.').length + 1
        );
      });
    }
    if (directOnly) {
      return this.treeChildren;
    } else {
      const descendents: ElementDefinition[] = [];
      for (const child of this.treeChildren) {
        descendents.push(child);
        descendents.push(...child.children());
      }
      return descendents;
    }
  }

  /**
   * Finds and returns all assignable descendents of the element. A assignable descendent is a direct child of the
   * element that has minimum cardinality greater than 0, and all assignable descendents of such children
   * @returns {ElementDefinition[]} the assignable descendents of this element
   */
  getAssignableDescendents(): ElementDefinition[] {
    const assignableChildren = this.children(true).filter(e => e.min > 0);
    let assignableDescendents: ElementDefinition[] = [];
    assignableChildren.forEach(ac => {
      assignableDescendents = assignableDescendents.concat(ac.getAssignableDescendents());
    });
    return [...assignableChildren, ...assignableDescendents];
  }

  /**
   * Finds and returns the element being sliced
   * @returns {ElementDefinition | undefined} the sliced element or undefined if the element is not a slice
   */
  slicedElement(): ElementDefinition | undefined {
    if (this.sliceName) {
      return (this.parent()?.children(true) ?? this.structDef.elements).find(
        e => e.id === this.id.slice(0, this.id.lastIndexOf(':'))
      );
    }
  }

  /**
   * If the element has a single type, graft the type's elements into this StructureDefinition as child elements.
   * If the element is sliced, unfold from the sliced element on the StructureDefinition
   * If the element is a content reference, unfold from the referenced element on the StructureDefintion
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   * @returns {ElementDefinition[]} the unfolded elements or an empty array if the type is multi-value or type can't
   *   be resolved.
   */
  unfold(fisher: Fishable): ElementDefinition[] {
    // if we have a choice element where id ends with [x], proceed if there is at most one profile, since it expects to get [] back in that case
    // if we don't have a choice element, proceed with any number of profiles
    const isChoiceElement = this.id.endsWith('[x]');
    const proceedToUnfold =
      (this.type?.length === 1 && (!isChoiceElement || (this.type[0].profile ?? []).length <= 1)) ||
      this.contentReference;
    if (proceedToUnfold) {
      let profileToUse: string;
      const availableProfiles = this.type?.length === 1 ? this.type[0].profile : [];
      // if more than one profile is available, none of them can be used, since there's no way to decide.
      if (availableProfiles?.length > 1) {
        logger.warn(
          `Multiple profiles present on element ${this.id}. Base element type will be used instead of any profiles.`
        );
      } else if (availableProfiles?.length === 1) {
        profileToUse = availableProfiles[0];
      }
      let newElements: ElementDefinition[] = [];
      if (this.contentReference) {
        // Get the original resource JSON so we unfold unconstrained reference
        const type = this.structDef.type;
        const json = fisher.fishForFHIR(type, Type.Resource, Type.Logical);
        // contentReference elements will not contain a type field, so we must fish for the StructDef and
        // check the differential
        const profileJson = fisher.fishForFHIR(this.structDef.id, Type.Profile);
        if (profileJson && this.hasProfileElementExtension(profileJson)) {
          const def = this.structDef;
          // Content references start with #, slice that off to get the id of referenced element
          const contentRefId = this.getContentReferenceId();
          const referencedElement = def.findElement(contentRefId);
          newElements = this.cloneChildren(referencedElement);
          if (newElements.length > 0) {
            // If we successfully unfolded, this element is no longer a content reference
            this.type = referencedElement.type;
            delete this.contentReference;
          }
        } else if (json) {
          const def = StructureDefinition.fromJSON(json);
          // Content references start with #, slice that off to id of referenced element
          const contentRefId = this.getContentReferenceId();
          const referencedElement = def.findElement(contentRefId);
          newElements = this.cloneChildren(referencedElement);
          if (newElements.length > 0) {
            // If we successfully unfolded, this element is no longer a content reference
            this.type = referencedElement.type;
            delete this.contentReference;
          }
        }
      } else if (this.sliceName) {
        // if this has a different profile than slicedElement, prefer to use that profile.
        // if this doesn't have a profile, or it has the same profile as slicedElement, then copy from slicedElement.
        const slicedElement = this.slicedElement();
        if (slicedElement != null) {
          if (!profileToUse) {
            newElements = this.cloneChildren(slicedElement, false);
          } else if (
            slicedElement.type.length === 1 &&
            slicedElement.type[0].profile?.length === 1 &&
            slicedElement.type[0].profile[0] === profileToUse
          ) {
            newElements = this.cloneChildren(slicedElement, false);
          }
        } else {
          // This can happen in the case of incomplete StructureDefinitions.
          // When this happens, all we can do is continue to the next step to try and add the child elements.
          logger.debug(
            `Could not get sliced element for ${this.id}: StructureDefinition ${this.structDef.id} may be missing slicing information`
          );
        }
      }
      if (newElements.length === 0) {
        // If we have exactly one profile to use, use that, otherwise use the code
        const type = profileToUse ?? this.type[0].code;
        // Fish on standard types, but if this is a logical model, also fish on logical models
        const typesToFish = [Type.Resource, Type.Type, Type.Profile, Type.Extension];
        if (this.structDef?.kind === 'logical') {
          typesToFish.unshift(Type.Logical);
        }
        // There could possibly be a |version appended to the type, so try to fish
        // for that version but fall back to any version if necessary
        let json = fishForFHIRBestVersion(
          fisher,
          type,
          null, // no source info
          ...typesToFish
        );
        if (!json && profileToUse) {
          logger.warn(
            `SUSHI tried to find profile ${type} but could not find it and instead will try to use ${this.type[0].code}`
          );
          // If we tried to fish based on a profile and didn't find anything, fall back to the type
          json = fisher.fishForFHIR(this.type[0].code, ...typesToFish);
        }
        if (json) {
          const def = StructureDefinition.fromJSON(json);
          if (def.inProgress) {
            logger.debug(
              `Warning: Circular relationship detected between ${this.structDef?.name} and ${def.name}. As a result, it is possible that the definition of ${this.structDef?.name} may be based on incomplete components of ${def.name}.`
            );
          }
          newElements = def.elements.slice(1).map(e => {
            const eClone = e.clone();
            eClone.id = eClone.id.replace(def.pathType, `${this.id}`);
            eClone.structDef = this.structDef;
            // Capture the original so that diffs only show what changed *after* unfolding
            eClone.captureOriginal();
            return eClone;
          });
        }
      }
      if (newElements.length > 0) {
        this.structDef.addElements(newElements);
        return newElements;
      }
    }
    return [];
  }

  /**
   * Returns an array of an ElementDefinition's unfolded children.
   * @param {ElementDefinition} targetElement - The ElementDefinition being unfolded
   * @param {boolean} recaptureSliceExtensions - Indicates whether or not slice extensions should be recaptured
   * @returns {ElementDefinition[]} An array of the targetElement's children, with the IDs altered and
   * the original property re-captured.
   */
  private cloneChildren(
    targetElement: ElementDefinition,
    recaptureSliceExtensions = true
  ): ElementDefinition[] {
    return targetElement?.children().map(e => {
      // Sometimes we want to avoid recapturing extensions, but if an element is not a slice
      // extension, we always capture it
      const shouldCaptureOriginal =
        recaptureSliceExtensions || e.sliceName == null || !e.path.endsWith('.extension');
      const eClone = e.clone(shouldCaptureOriginal);
      eClone.id = eClone.id.replace(targetElement.id, this.id);
      eClone.structDef = this.structDef;
      if (shouldCaptureOriginal) {
        eClone.captureOriginal();
      }
      return eClone;
    });
  }

  /**
   * Checks a StructureDefinition's differential to determine if the profile element extension has been used on
   * an element.
   * @param {Object} profileJson - The json representation of this ElementDefinition's structDef
   * @returns {boolean} True if the profile element extension is found on this elements profile property, false
   * if the extension is not found
   */
  private hasProfileElementExtension(profileJson: any): boolean {
    const elementName = this.getContentReferenceId();

    const elementType = profileJson.differential.element.find(
      (element: any) => element.id === elementName
    )?.type?.[0];

    // If the type property is not present in the differential, the profile-element extension is not present
    if (!elementType) {
      return false;
    }

    let profileCanonical, extensionUrl, targetElement: string;

    // If the profile and _profile arrays are not present, the profile-element extension is not present
    if (elementType.profile && elementType._profile) {
      const profileIndex = elementType._profile.findIndex(
        (profile: any) =>
          profile &&
          profile.extension.some(
            (extension: any) =>
              extension.hasOwnProperty('url') &&
              extension.hasOwnProperty('valueString') &&
              extension.url === PROFILE_ELEMENT_EXTENSION
          )
      );

      if (profileIndex === -1) {
        return false;
      }

      const extensionIndex = elementType._profile[profileIndex].extension?.findIndex(
        (extensionObj: any) =>
          extensionObj.hasOwnProperty('url') &&
          extensionObj.hasOwnProperty('valueString') &&
          extensionObj.url === PROFILE_ELEMENT_EXTENSION
      );
      extensionUrl = elementType._profile[profileIndex].extension[extensionIndex].url;
      targetElement = elementType._profile[profileIndex].extension[extensionIndex].valueString;
      profileCanonical = elementType.profile[profileIndex];
    } else {
      return false;
    }

    return (
      profileCanonical === this.structDef.url &&
      extensionUrl === PROFILE_ELEMENT_EXTENSION &&
      targetElement === elementName
    );
  }

  private getContentReferenceId(): string | undefined {
    if (this.contentReference) {
      return this.contentReference.slice(this.contentReference.indexOf('#') + 1);
    }
  }

  /**
   * Unfolds a choice element's typed choices. The elements added to this element's
   * structure definition are those that are on the common ancestor of the available types.
   * All types have a common ancestor of Element, so if all else fails, Element's
   * elements are used.
   *
   * @param {Fishable} fisher - A fishable implementation for finding definitions and metadata
   */
  unfoldChoiceElementTypes(fisher: Fishable): ElementDefinition[] {
    const allTypes: string[] = [];
    this.type.forEach(t => {
      if (t.profile?.length) {
        allTypes.push(...t.profile);
      } else {
        allTypes.push(t.code);
      }
    });
    const allTypeAncestry = allTypes.map(t => this.getTypeLineage(t, fisher).map(l => l.url));
    const sharedAncestry = intersectionWith(...allTypeAncestry);
    if (sharedAncestry.length > 0) {
      const commonAncestor = StructureDefinition.fromJSON(fisher.fishForFHIR(sharedAncestry[0]));
      const newElements = commonAncestor.elements.slice(1).map(e => {
        const eClone = e.clone();
        eClone.id = eClone.id.replace(commonAncestor.pathType, `${this.id}`);
        eClone.structDef = this.structDef;
        // Capture the original so that diffs only show what changed *after* unfolding
        eClone.captureOriginal();
        return eClone;
      });
      this.structDef.addElements(newElements);
      return newElements;
    } else {
      // this should not be reachable if the rest of the software is working correctly
      logger.error(`Could not unfold choice element ${this.id}: choices have no common ancestor.`);
    }
    return [];
  }

  /**
   * Sets up slicings on an element by adding or modifying the element's `slicing`.  If a matching slicing discriminator
   * already exists, it will be used
   * @see {@link http://hl7.org/fhir/R4/profiling.html#slicing}
   * @param {string} discriminatorType - the discriminator type ('value' | 'exists' | 'pattern' | 'type' | 'profile')
   * @param {string} discriminatorPath - the dot-separated discriminator path
   * @param {boolean} [ordered] - indicates if the slices are ordered. If no value is provided, it will default to false
   * for new slicings or accept the existing value for existing slicings.
   * @param {string} [rules] - indicates if addition slices are allowed or not ('closed' | 'open' | 'openAtEnd'). If no
   * value is provided, it will default to 'open' for new slicings or accept the existing value for existing slicings.
   * @returns {ElementDefinitionSlicing} the slicing
   * @throws { SlicingDefinitionError } if ordered is changed from true to false or rules are changed from closed to
   * open/openAtEnd or openAtEnd is changed to open
   */
  sliceIt(
    discriminatorType: string,
    discriminatorPath: string,
    ordered?: boolean,
    rules?: string
  ): ElementDefinitionSlicing {
    if (this.sliceName) {
      // slices should not have slicing info added to them
      // see also https://chat.fhir.org/#narrow/stream/179252-IG-creation/topic/Reslicing.20extensions.20causes.20validator.20errors/near/360153471
      logger.warn(`${this.id} is a slice. Slices should not have slicing info added to them.`);
    }
    if (!this.slicing || !this.slicing.discriminator) {
      this.slicing = {
        discriminator: [
          {
            type: discriminatorType,
            path: discriminatorPath
          }
        ],
        ordered: ordered != null ? ordered : false,
        rules: rules != null ? rules : 'open'
      };
    } else {
      // Ordered cannot be changed from true to false
      if (this.slicing.ordered && ordered === false) {
        throw new SlicingDefinitionError('ordered', true, false);
      }
      // Rules cannot be changed from closed to open/openAtEnd or openAtEnd to open
      if (
        (this.slicing.rules === 'closed' && rules !== 'closed') ||
        (this.slicing.rules === 'openAtEnd' && rules === 'open')
      ) {
        throw new SlicingDefinitionError('rules', this.slicing.rules, rules);
      }

      if (ordered != null && this.slicing.ordered !== ordered) {
        this.slicing.ordered = ordered;
      }

      if (rules != null && this.slicing.rules !== rules) {
        this.slicing.rules = rules;
      }

      if (
        !this.slicing.discriminator.some(
          d => d.type === discriminatorType && d.path === discriminatorPath
        )
      ) {
        this.slicing.discriminator.push({
          type: discriminatorType,
          path: discriminatorPath
        });
      }
    }

    return this.slicing;
  }

  /**
   * Creates a new slice on the element.
   * @see {@link http://hl7.org/fhir/R4/profiling.html#slicing}
   * @param {string} name - the name of the new slice
   * @param { ElementDefinitionType } [type] - the type of the new slice; if undefined it copies over this element's types
   * @returns {ElementDefinition} the new element representing the slice
   */
  addSlice(name: string, type?: ElementDefinitionType): ElementDefinition {
    // to add a slice, an element must either have slicing information, or must itself be a slice.
    // see also https://chat.fhir.org/#narrow/stream/179252-IG-creation/topic/Reslicing.20extensions.20causes.20validator.20errors/near/360153471
    if (!this.slicing && !this.sliceName) {
      throw new SlicingNotDefinedError(this.id, name);
    }

    const slice = this.clone(true);
    delete slice.slicing;
    slice.id = this.sliceName ? `${this.id}/${name}` : `${this.id}:${name}`;

    // if a slice with the same id already exists, don't add it again
    const existingSlice = this.structDef.findElement(slice.id);
    if (existingSlice) {
      throw new DuplicateSliceError(this.structDef.name, this.id, name);
    }

    // On a new slice, delete slice.min, slice.max, and slice.mustSupport. Then, reset slice.min and slice.max
    // so that they are always captured in diff
    delete slice.min;
    delete slice.max;
    delete slice.mustSupport;

    // Capture the original so that the differential only contains changes from this point on.
    slice.captureOriginal();
    slice.sliceName = this.sliceName ? `${this.sliceName}/${name}` : name;

    // Usually, when we slice, we do not inherit min cardinality, but rather make it 0.
    // This allows multiple slices to be defined without violating cardinality of sliced element.
    // Cardinality can be later narrowed by card constraints, which check validity of narrowing.
    // See: https://chat.fhir.org/#narrow/stream/179239-tooling/topic/Slicing.201.2E.2E.3F.20element
    // BUT... if it's a choice that has already been constrained to a single type (thus, not really a choice),
    // and this is a type slice, then the slice is essentially the *same* as what is being sliced and therefore
    // should retain min card. See: https://github.com/FHIR/sushi/issues/596
    if (
      this.path.endsWith('[x]') &&
      this.type.length === 1 &&
      this.slicing?.discriminator?.[0].type === 'type' &&
      this.slicing?.discriminator?.[0].path === '$this'
    ) {
      slice.min = this.min;
    } else {
      slice.min = 0;
    }

    slice.max = this.max;
    if (type) {
      slice.type = [type];
    }
    this.structDef.addElement(slice);
    return slice;
  }

  isPartOfComplexExtension(): boolean {
    return (
      this.structDef.type === 'Extension' &&
      [this, ...this.getAllParents().slice(0, -1)].every(
        ed => ed.type?.length === 1 && ed.type[0].code === 'Extension' && ed.sliceName != null
      )
    );
  }

  /**
   * Clones the current ElementDefinition, optionally clearing the stored "original" (clears it by default)
   * @param {boolean} [clearOriginal=true] - indicates if the stored "original" should be cleared
   * @returns {ElementDefinition} the cloned ElementDefinition
   */
  clone(clearOriginal = true): ElementDefinition {
    // We don't want to clone the reference to the StructureDefinition, so temporarily save it and remove it
    const savedStructDef = this.structDef;
    this.structDef = null;
    // We don't want to clone the tree references either
    const savedTreeParent = this.treeParent;
    this.treeParent = undefined;
    const savedTreeChildren = this.treeChildren;
    this.treeChildren = undefined;
    const clone = cloneDeep(this);
    // Set the reference to the StructureDefinition and nearby ElementDefinitions again
    // we want the clone to know about the StructureDefinition, but not have any tree relationships
    this.structDef = clone.structDef = savedStructDef;
    this.treeParent = savedTreeParent;
    this.treeChildren = savedTreeChildren;
    // Clear original if applicable
    if (clearOriginal) {
      clone.clearOriginal();
    }
    return clone;
  }

  /**
   * Provides the FHIR-conformant JSON representation of this ElementDefinition
   * @returns {Object} the FHIR-conformant JSON representation of this ElementDefinition
   */
  toJSON(): LooseElementDefJSON {
    const j: LooseElementDefJSON = {};
    for (let prop of PROPS_AND_UNDERPROPS) {
      if (prop.endsWith('[x]')) {
        const re = new RegExp(`^${prop.slice(0, -3)}[A-Z].*$`);
        prop = Object.keys(this).find(p => re.test(p));
      }
      // @ts-ignore
      if (prop && this[prop] !== undefined) {
        if (prop === 'type') {
          j.type = this.type.map(t => t.toJSON());
        } else {
          // @ts-ignore
          j[prop] = cloneDeep(this[prop]);
        }
      }
    }

    return j;
  }

  /**
   * Instantiates a new ElementDefinition from a FHIR-conformant JSON representation
   * @param {Object} json - the FHIR-conformant JSON representation of the ElementDefinition to instantiate
   * @param {captureOriginal} - indicate if original element should be captured for purposes of detecting
   *   differential.  Defaults to true.
   * @returns {ElementDefinition} the ElementDefinition representing the data passed in
   */
  static fromJSON(json: LooseElementDefJSON, captureOriginal = true): ElementDefinition {
    json = cloneDeep(json);
    const ed = new ElementDefinition();
    for (let prop of PROPS_AND_UNDERPROPS) {
      if (prop.endsWith('[x]')) {
        const re = new RegExp(`^${prop.slice(0, -3)}[A-Z].*$`);
        prop = Object.keys(json).find(p => re.test(p));
      }
      // @ts-ignore
      if (prop && json[prop] !== undefined) {
        if (prop === 'type') {
          ed.type = json[prop].map(type => ElementDefinitionType.fromJSON(type));
        } else {
          // @ts-ignore
          ed[prop] = json[prop];
        }
      }
    }
    if (captureOriginal) {
      ed.captureOriginal();
    }

    return ed;
  }
}

export type ElementDefinitionSlicing = {
  discriminator?: ElementDefinitionSlicingDiscriminator[];
  description?: string;
  ordered?: boolean;
  rules: string;
};

// Cannot constrain ElementDefinitionSlicing.rules to have these values as a type
// since we want to process other string values, but log an error
const ALLOWED_SLICING_RULES = ['closed', 'open', 'openAtEnd'];

export type ElementDefinitionSlicingDiscriminator = {
  type: string;
  path: string;
};

// Cannot constrain ElementDefinitionSlicingDiscriminator to have these values as a type
// since we want to process other string values, but log an error
const ALLOWED_DISCRIMINATOR_TYPES = ['value', 'exists', 'pattern', 'type', 'profile'];
// R5 introduced the 'position' discriminator
const ALLOWED_DISCRIMINATOR_TYPES_R5 = [
  'value',
  'exists',
  'pattern',
  'type',
  'profile',
  'position'
];

export type ElementDefinitionBase = {
  path: string;
  min: number;
  max: string;
};

export type ElementDefinitionTypeJSON = {
  code: string;
  profile?: string[];
  targetProfile?: string[];
  aggregation?: string[];
  versioning?: string;
  extension?: ElementDefinitionExtension[];
};

export type ElementDefinitionExtension = {
  url: string;
  // TODO: support all the value[x]
  valueUrl?: string;
  valueUri?: string;
};

export type ElementDefinitionExample = {
  label: string;
  // TODO: support all the value[x]
  // [key: string]: any;
};

export type ElementDefinitionConstraint = {
  key: string;
  requirements?: string;
  severity: string;
  human: string;
  expression?: string;
  xpath?: string;
  source?: string;
};

export type ElementDefinitionBinding = {
  strength: ElementDefinitionBindingStrength;
  description?: string;
  valueSet?: string;
};

export type ElementDefinitionBindingStrength = 'example' | 'preferred' | 'extensible' | 'required';

export type ElementDefinitionMapping = {
  identity: string;
  language?: string;
  map: string;
  comment?: string;
};

/**
 * A barebones and lenient definition of ElementDefinition JSON
 */
export interface LooseElementDefJSON {
  id?: string;
  path?: string;
  slicing?: ElementDefinitionSlicing;
  type?: ElementDefinitionTypeJSON[];
  binding?: ElementDefinitionBinding;
  // [key: string]: any;
}

interface ElementTypeMatchInfo {
  code: string;
  metadata: Metadata;
  typeName: string;
}

/**
 * The list of ElementDefinition properties used when importing/exporting FHIR JSON.
 */
const PROPS = [
  'id',
  'extension',
  'modifierExtension',
  'path',
  'representation',
  'sliceName',
  'sliceIsConstraining',
  'label',
  'code',
  'slicing',
  'short',
  'definition',
  'comment',
  'requirements',
  'alias',
  'min',
  'max',
  'base',
  'contentReference',
  'type',
  'defaultValue[x]',
  'meaningWhenMissing',
  'orderMeaning',
  'fixed[x]',
  'pattern[x]',
  'example',
  'minValue[x]',
  'maxValue[x]',
  'maxLength',
  'condition',
  'constraint',
  'mustSupport',
  'isModifier',
  'isModifierReason',
  'isSummary',
  'binding',
  'mapping'
];

const PROPS_AND_UNDERPROPS: string[] = PROPS.reduce((collect: string[], prop) => {
  collect.push(prop, `_${prop}`);
  return collect;
}, []);

/**
 * These list properties are considered to be additive in the differential.
 * Thus, the differential should contain only new entries in these lists.
 * See http://hl7.org/fhir/elementdefinition.html#interpretation.
 */
const ADDITIVE_PROPS = ['mapping', 'constraint'];

/**
 * These list properties are replaced in child profiles. If they are modified
 * in a profile, the snapshot should contain only entries in that profile,
 * and not in the parent profile. Each property is given as a list of
 * path parts.
 * For more context and a specific example, see this Zulip thread:
 * https://chat.fhir.org/#narrow/stream/215610-shorthand/topic/restricting.20aggregation.20type/near/413120070
 */
const REPLACEMENT_PROPS = [['type', 'aggregation']];
