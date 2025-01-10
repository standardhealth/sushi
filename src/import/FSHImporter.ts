import * as pc from './parserContexts';
import { FSHDocument } from './FSHDocument';
import { RawFSH } from './RawFSH';
import { FSHErrorListener } from './FSHErrorListener';
import FSHVisitor from './generated/FSHVisitor';
import FSHLexer from './generated/FSHLexer';
import FSHParser from './generated/FSHParser';
import {
  Profile,
  Extension,
  Resource,
  Logical,
  FshCanonical,
  FshCode,
  FshQuantity,
  FshRatio,
  FshReference,
  TextLocation,
  Instance,
  InstanceUsage,
  FshValueSet,
  ValueSetComponentFrom,
  ValueSetFilter,
  VsOperator,
  ValueSetFilterValue,
  FshCodeSystem,
  Invariant,
  RuleSet,
  ParamRuleSet,
  Mapping,
  isInstanceUsage,
  ExtensionContext
} from '../fshtypes';
import {
  CardRule,
  FlagRule,
  BindingRule,
  AssignmentRule,
  AssignmentValueType,
  OnlyRule,
  ContainsRule,
  ContainsRuleItem,
  CaretValueRule,
  ObeysRule,
  MappingRule,
  InsertRule,
  ConceptRule,
  ValueSetComponentRule,
  ValueSetConceptComponentRule,
  ValueSetFilterComponentRule,
  SdRule,
  LrRule,
  AddElementRule,
  OnlyRuleType,
  PathRule
} from '../fshtypes/rules';
import { CONFORMANCE_AND_TERMINOLOGY_RESOURCES, splitOnPathPeriods } from '../fhirtypes/common';
import { ParserRuleContext, InputStream, CommonTokenStream, TerminalNode } from 'antlr4';
import { logger, switchToSecretLogger, LoggerData, restoreMainLogger } from '../utils/FSHLogger';
import {
  RequiredMetadataError,
  ValueSetFilterOperatorError,
  ValueSetFilterValueTypeError,
  ValueSetFilterMissingValueError
} from '../errors';
import isEmpty from 'lodash/isEmpty';
import isEqual from 'lodash/isEqual';
import sortBy from 'lodash/sortBy';
import upperFirst from 'lodash/upperFirst';
import _min from 'lodash/min';
import { parseCodeLexeme } from './parseCodeLexeme';
import { EOL } from 'os';
import { applyRuleSetSubstitutions } from './MiniFSHImporter';

enum SdMetadataKey {
  Id = 'Id',
  Parent = 'Parent',
  Title = 'Title',
  Description = 'Description',
  Unknown = 'Unknown'
}

enum InstanceMetadataKey {
  InstanceOf = 'InstanceOf',
  Title = 'Title',
  Description = 'Description',
  Usage = 'Usage',
  Unknown = 'Unknown'
}

enum VsMetadataKey {
  Id = 'Id',
  Title = 'Title',
  Description = 'Description',
  Unknown = 'Unknown'
}

enum CsMetadataKey {
  Id = 'Id',
  Title = 'Title',
  Description = 'Description',
  Unknown = 'Unknown'
}

enum InvariantMetadataKey {
  Description = 'Description',
  Expression = 'Expression',
  XPath = 'XPath',
  Severity = 'Severity',
  Unknown = 'Unknown'
}

enum MappingMetadataKey {
  Id = 'Id',
  Source = 'Source',
  Target = 'Target',
  Description = 'Description',
  Title = 'Title',
  Unknown = 'Unknown'
}

enum Flag {
  MustSupport,
  Summary,
  Modifier,
  TrialUse,
  Normative,
  Draft,
  Unknown
}

const FLAGS = ['MS', 'SU', '?!', 'TU', 'N', 'D'];
const INDENT_WIDTH = 2;
const DEFAULT_START_COLUMN = 1;
const aliasRegex = /^\$?[a-zA-z0-9_\-\.]+$/;

function unescapeUnicode(match: string, p1: string): string {
  return JSON.parse(`"\\${p1}"`);
}

/**
 * FSHImporter handles the parsing of FSH documents, constructing the data into FSH types.
 * FSHImporter uses a visitor pattern approach with some accomodations due to the ANTLR4
 * implementation and TypeScript requirements.  For example, the `accept` functions that
 * each `ctx` has cannot be used because their signatures return `void` by default. Instead,
 * we must call the explicit visitX functions.
 */
export class FSHImporter extends FSHVisitor {
  private docs: FSHDocument[] = [];
  private currentFile: string;
  private currentDoc: FSHDocument;
  private allAliases: Map<string, string>;
  paramRuleSets: Map<string, ParamRuleSet>;
  private topLevelParse: boolean;
  private pathContext: string[][];

  constructor() {
    super();
    this.paramRuleSets = new Map();
    this.topLevelParse = true;
  }

  import(rawFSHes: RawFSH[]): FSHDocument[] {
    this.allAliases = new Map();
    const contexts: pc.DocContext[] = [];

    // Preprocess the FSH files
    rawFSHes.forEach(rawFSH => {
      // Create and store doc for main import process
      const doc = new FSHDocument(rawFSH.path);
      this.docs.push(doc);
      this.currentDoc = doc;
      this.currentFile = this.currentDoc.file ?? '';

      // Create and store context for main import process
      // We are appending a newline to the file content if there is not one there already.
      // This is being done because we discovered a syntax error that occurs if a comments
      // ends a file, and there is no newline after it. Comments are only tokenized in our
      // grammar if a newline follows it. In order to prevent this error from occurring,
      // we add a newline to the content before we parse it so comments at EOF can be tokenized.
      const content = rawFSH.content.endsWith('\n') ? rawFSH.content : rawFSH.content + '\n';
      const ctx = this.parseDoc(content, rawFSH.path);
      contexts.push(ctx);

      // Collect the aliases and store in global map
      ctx.entity().forEach(e => {
        if (e.alias()) {
          const name = e.alias().name().getText();
          let value = e.alias().SEQUENCE()?.getText();
          // When the url contains a fragment (http://example.org#fragment), the grammar will read it as a
          // CODE, so we also accept that for the value here
          if (!value && e.alias().CODE()) {
            value = e.alias().CODE().getText();
          }
          if (name.includes('|')) {
            logger.error(
              `Alias ${name} cannot include "|" since the "|" character is reserved for indicating a version`,
              { file: doc.file ?? '', location: this.extractStartStop(e.alias()) }
            );
            return;
          } else if (!aliasRegex.test(name)) {
            logger.warn(
              `Alias ${name} includes unsupported characters. Alias names can only contain letters, numbers, underscores ("_"), hyphens ("-"), and dots (".").`,
              { file: doc.file ?? '', location: this.extractStartStop(e.alias()) }
            );
          }
          if (this.allAliases.has(name) && this.allAliases.get(name) !== value) {
            logger.error(
              `Alias ${name} cannot be redefined to ${value}; it is already defined as ${this.allAliases.get(
                name
              )}.`,
              { file: doc.file ?? '', location: this.extractStartStop(e.alias()) }
            );
            // don't set it -- just keep the original definition
          } else {
            this.allAliases.set(name, value);
            doc.aliases.set(name, value);
          }
        }
        if (e.paramRuleSet()) {
          this.visitParamRuleSet(e.paramRuleSet());
        }
      });
      this.currentDoc = null;
      this.currentFile = null;
    });
    logger.info(`Preprocessed ${this.docs.length} documents with ${this.allAliases.size} aliases.`);

    // Now do the main import
    contexts.forEach((context, index) => {
      this.currentDoc = this.docs[index];
      this.currentFile = this.currentDoc.file ?? '';
      this.visitDoc(context);
      this.currentDoc = null;
      this.currentFile = null;
    });

    let [definitions, instances] = [0, 0];
    this.docs.forEach(doc => {
      definitions +=
        doc.codeSystems.size +
        doc.extensions.size +
        doc.profiles.size +
        doc.valueSets.size +
        doc.logicals.size +
        doc.resources.size;
      instances += doc.instances.size;
    });
    logger.info(`Imported ${definitions} definitions and ${instances} instances.`);

    return this.docs;
  }

  visitDoc(ctx: pc.DocContext): void {
    ctx.entity().forEach(e => {
      try {
        this.visitEntity(e);
      } catch (err) {
        const sourceInfo = { location: this.extractStartStop(e), file: this.currentFile };
        logger.error(`Error in parsing: ${err.message}`, sourceInfo);
        if (err.stack) {
          logger.debug(err.stack);
        }
      }
    });
  }

  visitEntity(ctx: pc.EntityContext): void {
    // Reset the pathContext for each entity
    this.pathContext = [];

    if (ctx.profile()) {
      this.visitProfile(ctx.profile());
    } else if (ctx.extension()) {
      this.visitExtension(ctx.extension());
    } else if (ctx.resource()) {
      this.visitResource(ctx.resource());
    } else if (ctx.logical()) {
      this.visitLogical(ctx.logical());
    } else if (ctx.instance()) {
      this.visitInstance(ctx.instance());
    } else if (ctx.valueSet()) {
      this.visitValueSet(ctx.valueSet());
    } else if (ctx.codeSystem()) {
      this.visitCodeSystem(ctx.codeSystem());
    } else if (ctx.invariant()) {
      this.visitInvariant(ctx.invariant());
    } else if (ctx.ruleSet()) {
      this.visitRuleSet(ctx.ruleSet());
    } else if (ctx.mapping()) {
      this.visitMapping(ctx.mapping());
    }
  }

  visitProfile(ctx: pc.ProfileContext) {
    const profile = new Profile(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.profiles.has(profile.name))) {
      logger.error(`Skipping Profile: a Profile named ${profile.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseProfileOrExtension(profile, ctx.sdMetadata(), ctx.sdRule());
      this.currentDoc.profiles.set(profile.name, profile);
    }
  }

  visitExtension(ctx: pc.ExtensionContext) {
    const extension = new Extension(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.extensions.has(extension.name))) {
      logger.error(`Skipping Extension: an Extension named ${extension.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseProfileOrExtension(extension, ctx.sdMetadata(), ctx.sdRule());
      ctx.context().forEach(extContext => {
        if (extension.contexts?.length > 0) {
          logger.error("Metadata field 'Context' already declared.", {
            file: this.currentFile,
            location: this.extractStartStop(extContext)
          });
        } else {
          extension.contexts = this.visitContext(extContext);
        }
      });
      this.currentDoc.extensions.set(extension.name, extension);
    }
  }

  private parseProfileOrExtension(
    def: Profile | Extension,
    metaCtx: pc.SdMetadataContext[] = [],
    ruleCtx: pc.SdRuleContext[] = []
  ): void {
    const seenPairs: Map<SdMetadataKey, string | string[]> = new Map();
    metaCtx
      .map(sdMeta => ({ ...this.visitSdMetadata(sdMeta), context: sdMeta }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === SdMetadataKey.Id) {
          def.id = pair.value as string;
        } else if (pair.key === SdMetadataKey.Parent) {
          def.parent = pair.value as string;
        } else if (pair.key === SdMetadataKey.Title) {
          def.title = pair.value as string;
        } else if (pair.key === SdMetadataKey.Description) {
          def.description = pair.value as string;
        }
      });
    ruleCtx.forEach(sdRule => {
      def.rules.push(...this.visitSdRule(sdRule));
    });
  }

  visitResource(ctx: pc.ResourceContext) {
    const resource = new Resource(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.resources.has(resource.name))) {
      logger.error(`Skipping Resource: a Resource named ${resource.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseResourceOrLogical(resource, ctx.sdMetadata(), ctx.lrRule());
      this.currentDoc.resources.set(resource.name, resource);
    }
  }

  visitLogical(ctx: pc.LogicalContext) {
    const logical = new Logical(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.logicals.has(logical.name))) {
      logger.error(
        `Skipping Logical Model: a Logical Model named ${logical.name} already exists.`,
        {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        }
      );
    } else {
      this.parseResourceOrLogical(logical, ctx.sdMetadata(), ctx.lrRule());
      ctx.characteristics().forEach(characteristics => {
        if (logical.characteristics?.length > 0) {
          logger.error("Metadata field 'Characteristics' already declared.", {
            file: this.currentFile,
            location: this.extractStartStop(characteristics)
          });
        } else {
          logical.characteristics = this.visitCharacteristics(characteristics);
        }
      });
      this.currentDoc.logicals.set(logical.name, logical);
    }
  }

  private parseResourceOrLogical(
    def: Resource | Logical,
    metaCtx: pc.SdMetadataContext[] = [],
    ruleCtx: pc.LrRuleContext[] = []
  ): void {
    const seenPairs: Map<SdMetadataKey, string | string[]> = new Map();
    metaCtx
      .map(sdMeta => ({ ...this.visitSdMetadata(sdMeta), context: sdMeta }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === SdMetadataKey.Id) {
          def.id = pair.value as string;
        } else if (pair.key === SdMetadataKey.Parent) {
          def.parent = pair.value as string;
        } else if (pair.key === SdMetadataKey.Title) {
          def.title = pair.value as string;
        } else if (pair.key === SdMetadataKey.Description) {
          def.description = pair.value as string;
        }
      });
    ruleCtx.forEach(lrRule => {
      def.rules.push(...this.visitLrRule(lrRule));
    });
  }

  visitInstance(ctx: pc.InstanceContext) {
    const location = this.extractStartStop(ctx);
    const instance = new Instance(ctx.name().getText())
      .withLocation(location)
      .withFile(this.currentFile);
    {
      try {
        this.parseInstance(instance, location, ctx.instanceMetadata(), ctx.instanceRule());
        if (
          this.docs.some(
            doc =>
              doc.instances.has(instance.name) &&
              Array.from(doc.instances.values()).some(
                entity => entity.name === instance.name && entity.versionId === instance.versionId
              )
          )
        ) {
          const versionString = instance.versionId ? `with versionId ${instance.versionId} ` : '';
          logger.error(
            `Skipping Instance: an Instance named ${instance.name} ${versionString}already exists.`,
            {
              file: this.currentFile,
              location
            }
          );
        } else {
          this.currentDoc.instances.set(instance.name, instance);
        }
      } catch (e) {
        logger.error(e.message, instance.sourceInfo);
        if (e.stack) {
          logger.debug(e.stack);
        }
      }
    }
  }

  private parseInstance(
    instance: Instance,
    location: TextLocation,
    metaCtx: pc.InstanceMetadataContext[] = [],
    ruleCtx: pc.InstanceRuleContext[] = []
  ): void {
    const seenPairs: Map<InstanceMetadataKey, string | string[]> = new Map();
    metaCtx
      .map(instanceMetadata => ({
        ...this.visitInstanceMetadata(instanceMetadata),
        context: instanceMetadata
      }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === InstanceMetadataKey.InstanceOf) {
          instance.instanceOf = pair.value as string;
        } else if (pair.key === InstanceMetadataKey.Title) {
          instance.title = pair.value as string;
        } else if (pair.key === InstanceMetadataKey.Description) {
          instance.description = pair.value as string;
        } else if (pair.key === InstanceMetadataKey.Usage) {
          instance.usage = pair.value as InstanceUsage;
        }
      });
    if (!instance.instanceOf) {
      throw new RequiredMetadataError('InstanceOf', 'Instance', instance.name);
    }
    if (
      CONFORMANCE_AND_TERMINOLOGY_RESOURCES.has(instance.instanceOf) &&
      !metaCtx.some(ctx => ctx.usage())
    ) {
      logger.warn(
        `No usage was specified on ${instance.name}. The default #example usage will be applied, but ${instance.instanceOf} Instances are typically definitions. Specify a usage to remove this warning.`,
        {
          file: this.currentFile,
          location
        }
      );
    }
    ruleCtx.forEach(instanceRule => {
      const rule = this.visitInstanceRule(instanceRule);
      if (rule) {
        instance.rules.push(rule);
        if (rule instanceof AssignmentRule && rule.path === 'meta.versionId') {
          instance.versionId = rule.value.toString();
        }
      }
    });
  }

  visitValueSet(ctx: pc.ValueSetContext) {
    const valueSet = new FshValueSet(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.valueSets.has(valueSet.name))) {
      logger.error(`Skipping ValueSet: a ValueSet named ${valueSet.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseValueSet(valueSet, ctx.vsMetadata(), ctx.vsRule());
      this.currentDoc.valueSets.set(valueSet.name, valueSet);
    }
  }

  private parseValueSet(
    valueSet: FshValueSet,
    metaCtx: pc.VsMetadataContext[] = [],
    vsRuleCtx: pc.VsRuleContext[] = []
  ) {
    const seenPairs: Map<VsMetadataKey, string> = new Map();
    metaCtx
      .map(vsMetadata => ({
        ...this.visitVsMetadata(vsMetadata),
        context: vsMetadata
      }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === VsMetadataKey.Id) {
          valueSet.id = pair.value;
        } else if (pair.key === VsMetadataKey.Title) {
          valueSet.title = pair.value;
        } else if (pair.key === VsMetadataKey.Description) {
          valueSet.description = pair.value;
        }
      });
    vsRuleCtx.forEach(vsRule => {
      const rule = this.visitVsRule(vsRule);
      // if rule is a concept component,
      // we may be able to merge its concepts into an existing concept component.
      if (rule instanceof ValueSetConceptComponentRule) {
        const matchedComponent = valueSet.rules.find(existingComponent => {
          return (
            existingComponent instanceof ValueSetConceptComponentRule &&
            rule.inclusion == existingComponent.inclusion &&
            rule.from.system == existingComponent.from.system &&
            isEqual(sortBy(rule.from.valueSets), sortBy(existingComponent.from.valueSets))
          );
        }) as ValueSetConceptComponentRule;
        if (matchedComponent) {
          matchedComponent.concepts.push(...rule.concepts);
        } else {
          valueSet.rules.push(rule);
        }
      } else if (rule) {
        valueSet.rules.push(rule);
      }
    });
  }

  visitCodeSystem(ctx: pc.CodeSystemContext) {
    const codeSystem = new FshCodeSystem(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.codeSystems.has(codeSystem.name))) {
      logger.error(`Skipping code system: a code system named ${codeSystem.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseCodeSystem(codeSystem, ctx.csMetadata(), ctx.csRule());
      this.currentDoc.codeSystems.set(codeSystem.name, codeSystem);
    }
  }

  private parseCodeSystem(
    codeSystem: FshCodeSystem,
    metaCtx: pc.CsMetadataContext[] = [],
    csRuleCtx: pc.CsRuleContext[] = []
  ) {
    const seenPairs: Map<CsMetadataKey, string> = new Map();
    metaCtx
      .map(csMetadata => ({
        ...this.visitCsMetadata(csMetadata),
        context: csMetadata
      }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === CsMetadataKey.Id) {
          codeSystem.id = pair.value;
        } else if (pair.key === CsMetadataKey.Title) {
          codeSystem.title = pair.value;
        } else if (pair.key === CsMetadataKey.Description) {
          codeSystem.description = pair.value;
        }
      });
    csRuleCtx.forEach(ruleCtx => {
      const rule = this.visitCsRule(ruleCtx);
      codeSystem.rules.push(rule);
    });
  }

  visitInvariant(ctx: pc.InvariantContext) {
    const invariant = new Invariant(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.invariants.has(invariant.name))) {
      logger.error(`Skipping Invariant: an Invariant named ${invariant.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseInvariant(invariant, ctx.invariantMetadata(), ctx.invariantRule());
      this.currentDoc.invariants.set(invariant.name, invariant);
    }
  }

  private parseInvariant(
    invariant: Invariant,
    metaCtx: pc.InvariantMetadataContext[] = [],
    ruleCtx: pc.InvariantRuleContext[] = []
  ) {
    const seenPairs: Map<InvariantMetadataKey, string | FshCode> = new Map();
    metaCtx
      .map(invariantMetadata => ({
        ...this.visitInvariantMetadata(invariantMetadata),
        context: invariantMetadata
      }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === InvariantMetadataKey.Description) {
          invariant.description = pair.value as string;
        } else if (pair.key === InvariantMetadataKey.Expression) {
          invariant.expression = pair.value as string;
        } else if (pair.key === InvariantMetadataKey.Severity) {
          invariant.severity = pair.value as FshCode;
        } else if (pair.key === InvariantMetadataKey.XPath) {
          invariant.xpath = pair.value as string;
        }
      });
    ruleCtx.forEach(invariantRule => {
      const rule = this.visitInvariantRule(invariantRule);
      if (rule) {
        invariant.rules.push(rule);
      }
    });
  }

  visitRuleSet(ctx: pc.RuleSetContext): void {
    const ruleSet = new RuleSet(ctx.RULESET_REFERENCE().getText().trim())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.ruleSets.has(ruleSet.name))) {
      logger.error(`Skipping RuleSet: a RuleSet named ${ruleSet.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseRuleSet(ruleSet, ctx.ruleSetRule());
      this.currentDoc.ruleSets.set(ruleSet.name, ruleSet);
    }
  }

  private parseRuleSet(ruleSet: RuleSet, rules: pc.RuleSetRuleContext[]) {
    rules.forEach(rule => {
      if (rule.sdRule()) {
        ruleSet.rules.push(...this.visitSdRule(rule.sdRule()));
      } else if (rule.vsComponent()) {
        ruleSet.rules.push(this.visitVsComponent(rule.vsComponent()));
      } else if (rule.concept()) {
        ruleSet.rules.push(this.visitConcept(rule.concept()));
      } else if (rule.addElementRule()) {
        ruleSet.rules.push(this.visitAddElementRule(rule.addElementRule()));
      } else if (rule.addCRElementRule()) {
        ruleSet.rules.push(this.visitAddCRElementRule(rule.addCRElementRule()));
      } else if (rule.codeCaretValueRule()) {
        ruleSet.rules.push(this.visitCodeCaretValueRule(rule.codeCaretValueRule()));
      } else if (rule.mappingRule()) {
        ruleSet.rules.push(this.visitMappingRule(rule.mappingRule()));
      }
    });
  }

  visitParamRuleSet(ctx: pc.ParamRuleSetContext): void {
    const { name, params } = this.parseRuleSetReference(ctx.paramRuleSetRef());
    const paramRuleSet = new ParamRuleSet(name)
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.paramRuleSets.has(paramRuleSet.name)) {
      logger.error(`Skipping RuleSet: a RuleSet named ${paramRuleSet.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      paramRuleSet.parameters = params;
      paramRuleSet.contents = this.visitParamRuleSetContent(ctx.paramRuleSetContent());
      const unusedParameters = paramRuleSet.getUnusedParameters();
      if (unusedParameters.length > 0) {
        logger.warn(
          `RuleSet ${paramRuleSet.name} contains unused parameter${
            unusedParameters.length > 1 ? 's' : ''
          }: ${unusedParameters.join(', ')}`,
          paramRuleSet.sourceInfo
        );
      }
      this.paramRuleSets.set(paramRuleSet.name, paramRuleSet);
    }
  }

  visitParamRuleSetContent(ctx: pc.ParamRuleSetContentContext): string {
    return ctx.start.getInputStream().getText(ctx.start.start, ctx.stop.stop);
  }

  visitMapping(ctx: pc.MappingContext): void {
    const mapping = new Mapping(ctx.name().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (this.docs.some(doc => doc.mappings.has(mapping.name))) {
      logger.error(`Skipping Mapping: a Mapping named ${mapping.name} already exists.`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else {
      this.parseMapping(mapping, ctx.mappingMetadata(), ctx.mappingEntityRule());
      this.currentDoc.mappings.set(mapping.name, mapping);
    }
  }

  private parseMapping(
    mapping: Mapping,
    metaCtx: pc.MappingMetadataContext[] = [],
    ruleCtx: pc.MappingEntityRuleContext[] = []
  ): void {
    const seenPairs: Map<MappingMetadataKey, string> = new Map();
    metaCtx
      .map(mapMeta => ({ ...this.visitMappingMetadata(mapMeta), context: mapMeta }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === MappingMetadataKey.Id) {
          mapping.id = pair.value;
        } else if (pair.key === MappingMetadataKey.Source) {
          mapping.source = pair.value;
        } else if (pair.key === MappingMetadataKey.Target) {
          mapping.target = pair.value;
        } else if (pair.key === MappingMetadataKey.Description) {
          mapping.description = pair.value;
        } else if (pair.key === MappingMetadataKey.Title) {
          mapping.title = pair.value;
        }
      });
    ruleCtx.forEach(mappingRule => {
      const rule = this.visitMappingEntityRule(mappingRule);
      if (rule) {
        mapping.rules.push(rule);
      }
    });
  }

  visitSdMetadata(ctx: pc.SdMetadataContext): { key: SdMetadataKey; value: string | string[] } {
    if (ctx.id()) {
      return { key: SdMetadataKey.Id, value: this.visitId(ctx.id()) };
    } else if (ctx.parent()) {
      return { key: SdMetadataKey.Parent, value: this.visitParent(ctx.parent()) };
    } else if (ctx.title()) {
      return { key: SdMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    } else if (ctx.description()) {
      return { key: SdMetadataKey.Description, value: this.visitDescription(ctx.description()) };
    }
    return { key: SdMetadataKey.Unknown, value: ctx.getText() };
  }

  visitInstanceMetadata(ctx: pc.InstanceMetadataContext): {
    key: InstanceMetadataKey;
    value: string | string[];
  } {
    if (ctx.instanceOf()) {
      return { key: InstanceMetadataKey.InstanceOf, value: this.visitInstanceOf(ctx.instanceOf()) };
    } else if (ctx.title()) {
      return { key: InstanceMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    } else if (ctx.description()) {
      return {
        key: InstanceMetadataKey.Description,
        value: this.visitDescription(ctx.description())
      };
    } else if (ctx.usage()) {
      return {
        key: InstanceMetadataKey.Usage,
        value: this.visitUsage(ctx.usage())
      };
    }
    return { key: InstanceMetadataKey.Unknown, value: ctx.getText() };
  }

  visitVsMetadata(ctx: pc.VsMetadataContext): { key: VsMetadataKey; value: string } {
    if (ctx.id()) {
      return { key: VsMetadataKey.Id, value: this.visitId(ctx.id()) };
    } else if (ctx.title()) {
      return { key: VsMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    } else if (ctx.description()) {
      return { key: VsMetadataKey.Description, value: this.visitDescription(ctx.description()) };
    }
    return { key: VsMetadataKey.Unknown, value: ctx.getText() };
  }

  visitCsMetadata(ctx: pc.CsMetadataContext): { key: CsMetadataKey; value: string } {
    if (ctx.id()) {
      return { key: CsMetadataKey.Id, value: this.visitId(ctx.id()) };
    } else if (ctx.title()) {
      return { key: CsMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    } else if (ctx.description()) {
      return { key: CsMetadataKey.Description, value: this.visitDescription(ctx.description()) };
    }
    return { key: CsMetadataKey.Unknown, value: ctx.getText() };
  }

  visitInvariantMetadata(ctx: pc.InvariantMetadataContext): {
    key: InvariantMetadataKey;
    value: string | FshCode;
  } {
    if (ctx.description()) {
      return {
        key: InvariantMetadataKey.Description,
        value: this.visitDescription(ctx.description())
      };
    } else if (ctx.expression()) {
      return {
        key: InvariantMetadataKey.Expression,
        value: this.visitExpression(ctx.expression())
      };
    } else if (ctx.xpath()) {
      return {
        key: InvariantMetadataKey.XPath,
        value: this.visitXpath(ctx.xpath())
      };
    } else if (ctx.severity()) {
      return {
        key: InvariantMetadataKey.Severity,
        value: this.visitSeverity(ctx.severity())
      };
    }
    return {
      key: InvariantMetadataKey.Unknown,
      value: ctx.getText()
    };
  }

  visitMappingMetadata(ctx: pc.MappingMetadataContext): { key: MappingMetadataKey; value: string } {
    if (ctx.id()) {
      return { key: MappingMetadataKey.Id, value: this.visitId(ctx.id()) };
    } else if (ctx.source()) {
      return { key: MappingMetadataKey.Source, value: this.visitSource(ctx.source()) };
    } else if (ctx.target()) {
      return { key: MappingMetadataKey.Target, value: this.visitTarget(ctx.target()) };
    } else if (ctx.description()) {
      return {
        key: MappingMetadataKey.Description,
        value: this.visitDescription(ctx.description())
      };
    } else if (ctx.title()) {
      return { key: MappingMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    }
    return { key: MappingMetadataKey.Unknown, value: ctx.getText() };
  }

  visitId(ctx: pc.IdContext): string {
    return ctx.name().getText();
  }

  visitParent(ctx: pc.ParentContext): string {
    return this.aliasAwareValue(ctx.name());
  }

  visitTitle(ctx: pc.TitleContext): string {
    return this.extractString(ctx.STRING());
  }

  visitDescription(ctx: pc.DescriptionContext): string {
    if (ctx.STRING()) {
      return this.extractString(ctx.STRING());
    } else if (ctx.MULTILINE_STRING()) {
      return this.extractMultilineString(ctx.MULTILINE_STRING());
    }
    // this can happen due to parsing errors, so just return empty string
    return '';
  }

  visitInstanceOf(ctx: pc.InstanceOfContext): string {
    return this.aliasAwareValue(ctx.name());
  }

  visitUsage(ctx: pc.UsageContext): InstanceUsage {
    const usageConcept = this.parseCodeLexeme(ctx.CODE().getText(), ctx.CODE())
      .withLocation(this.extractStartStop(ctx.CODE()))
      .withFile(this.currentFile);
    if (usageConcept.system?.length > 0) {
      logger.warn('Do not specify a system for instance Usage.', usageConcept.sourceInfo);
    }
    let usage = upperFirst(usageConcept.code);
    if (!isInstanceUsage(usage)) {
      logger.error(
        'Invalid Usage. Supported usage codes are "#example", "#definition", and "#inline". Instance will be treated as an example.',
        usageConcept.sourceInfo
      );
      usage = 'Example';
    }
    return usage as InstanceUsage;
  }

  visitExpression(ctx: pc.ExpressionContext): string {
    return this.extractString(ctx.STRING());
  }

  visitXpath(ctx: pc.XpathContext): string {
    return this.extractString(ctx.STRING());
  }

  visitSeverity(ctx: pc.SeverityContext): FshCode {
    const concept = this.parseCodeLexeme(ctx.CODE().getText(), ctx.CODE())
      .withLocation(this.extractStartStop(ctx.CODE()))
      .withFile(this.currentFile);
    return concept;
  }

  visitSource(ctx: pc.SourceContext): string {
    return this.aliasAwareValue(ctx.name());
  }

  visitTarget(ctx: pc.TargetContext): string {
    return this.extractString(ctx.STRING());
  }

  visitContext(ctx: pc.ContextContext): ExtensionContext[] {
    const contexts: ExtensionContext[] = [];
    ctx.contextItem().forEach(contextItem => {
      if (contextItem.QUOTED_CONTEXT()) {
        contexts.push({
          value: this.unescapeQuotedString(
            contextItem.QUOTED_CONTEXT().getText().slice(0, -1).trim()
          ),
          isQuoted: true,
          sourceInfo: {
            file: this.currentFile,
            location: this.extractStartStop(contextItem.QUOTED_CONTEXT())
          }
        });
      } else {
        contexts.push({
          value: contextItem.UNQUOTED_CONTEXT().getText().slice(0, -1).trim(),
          isQuoted: false,
          sourceInfo: {
            file: this.currentFile,
            location: this.extractStartStop(contextItem.UNQUOTED_CONTEXT())
          }
        });
      }
    });
    if (ctx.lastContextItem().LAST_QUOTED_CONTEXT()) {
      contexts.push({
        value: this.unescapeQuotedString(ctx.lastContextItem().LAST_QUOTED_CONTEXT().getText()),
        isQuoted: true,
        sourceInfo: {
          file: this.currentFile,
          location: this.extractStartStop(ctx.lastContextItem().LAST_QUOTED_CONTEXT())
        }
      });
    } else {
      contexts.push({
        value: ctx.lastContextItem().LAST_UNQUOTED_CONTEXT().getText(),
        isQuoted: false,
        sourceInfo: {
          file: this.currentFile,
          location: this.extractStartStop(ctx.lastContextItem().LAST_UNQUOTED_CONTEXT())
        }
      });
    }
    return contexts;
  }

  visitCharacteristics(ctx: pc.CharacteristicsContext): string[] {
    const characteristics: string[] = [];
    ctx.CODE_ITEM().forEach(codeCtx => {
      const characteristicCode = codeCtx.getText().slice(0, -1).trim().slice(1);
      characteristics.push(characteristicCode);
    });
    const lastCode = ctx.LAST_CODE_ITEM().getText().trim().slice(1);
    characteristics.push(lastCode);
    return characteristics;
  }

  private parseCodeLexeme(conceptText: string, parentCtx: ParserRuleContext): FshCode {
    const concept = parseCodeLexeme(conceptText);
    if (concept.system?.length > 0) {
      concept.system = this.aliasAwareValue(parentCtx, concept.system);
    }
    return concept;
  }

  visitLrRule(ctx: pc.LrRuleContext): LrRule[] {
    if (ctx.addElementRule()) {
      return [this.visitAddElementRule(ctx.addElementRule())];
    } else if (ctx.addCRElementRule()) {
      return [this.visitAddCRElementRule(ctx.addCRElementRule())];
    } else if (ctx.sdRule()) {
      return this.visitSdRule(ctx.sdRule());
    }
    logger.warn(`Unsupported rule: ${ctx.getText()}`, {
      file: this.currentFile,
      location: this.extractStartStop(ctx)
    });
    return [];
  }

  visitAddElementRule(ctx: pc.AddElementRuleContext): AddElementRule {
    const addElementRule = this.parseNewElement(ctx);
    addElementRule.types = this.parseTargetType(ctx);
    addElementRule.types.forEach(onlyRuleType => {
      if (FLAGS.includes(onlyRuleType.type)) {
        logger.warn(
          `The targetType '${onlyRuleType.type}' appears to be a flag value rather than a valid target data type.`,
          {
            file: this.currentFile,
            location: this.extractStartStop(ctx)
          }
        );
      }
    });
    return addElementRule;
  }

  visitAddCRElementRule(ctx: pc.AddCRElementRuleContext): AddElementRule {
    const addElementRule = this.parseNewElement(ctx);
    if (ctx.SEQUENCE()) {
      addElementRule.contentReference = this.aliasAwareValue(ctx.SEQUENCE());
    } else if (ctx.CODE()) {
      addElementRule.contentReference = this.aliasAwareValue(ctx.CODE());
    }
    return addElementRule;
  }

  private parseNewElement(
    ctx: pc.AddElementRuleContext | pc.AddCRElementRuleContext
  ): AddElementRule {
    const path = this.getPathWithContext(this.visitPath(ctx.path()), ctx);
    const addElementRule = new AddElementRule(path)
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);

    const card = this.parseCard(ctx.CARD().getText(), addElementRule);
    if (card.min == null || Number.isNaN(card.min)) {
      logger.error(
        `The 'min' cardinality attribute in AddElementRule for path '${path}' must be specified.`,
        {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        }
      );
    }
    if (isEmpty(card.max)) {
      logger.error(
        `The 'max' cardinality attribute in AddElementRule for path '${path}' must be specified.`,
        {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        }
      );
    }
    addElementRule.min = card.min;
    addElementRule.max = card.max;

    if (ctx.flag() && ctx.flag().length > 0) {
      this.parseFlags(addElementRule, ctx.flag());
    }

    if (isEmpty(ctx.STRING())) {
      logger.error(
        `The 'short' attribute in AddElementRule for path '${path}' must be specified.`,
        {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        }
      );
    } else {
      addElementRule.short = this.extractString(ctx.STRING()[0]);
      if (isEmpty(ctx.STRING()[1]) && isEmpty(ctx.MULTILINE_STRING())) {
        // Default definition to the value of short
        addElementRule.definition = addElementRule.short;
      } else if (!isEmpty(ctx.STRING()[1])) {
        addElementRule.definition = this.extractString(ctx.STRING()[1]);
      } else {
        addElementRule.definition = this.extractMultilineString(ctx.MULTILINE_STRING());
      }
    }

    return addElementRule;
  }

  visitSdRule(ctx: pc.SdRuleContext): SdRule[] {
    if (ctx.cardRule()) {
      return this.visitCardRule(ctx.cardRule());
    } else if (ctx.flagRule()) {
      return this.visitFlagRule(ctx.flagRule());
    } else if (ctx.valueSetRule()) {
      return [this.visitValueSetRule(ctx.valueSetRule())];
    } else if (ctx.fixedValueRule()) {
      const rule = this.visitFixedValueRule(ctx.fixedValueRule());
      return [rule];
    } else if (ctx.onlyRule()) {
      return [this.visitOnlyRule(ctx.onlyRule())];
    } else if (ctx.containsRule()) {
      return this.visitContainsRule(ctx.containsRule());
    } else if (ctx.caretValueRule()) {
      return [this.visitCaretValueRule(ctx.caretValueRule())];
    } else if (ctx.obeysRule()) {
      return this.visitObeysRule(ctx.obeysRule());
    } else if (ctx.insertRule()) {
      const rule = this.visitInsertRule(ctx.insertRule());
      return rule ? [rule] : [];
    } else if (ctx.pathRule()) {
      this.visitPathRule(ctx.pathRule());
      return [];
    }
    logger.warn(`Unsupported rule: ${ctx.getText()}`, {
      file: this.currentFile,
      location: this.extractStartStop(ctx)
    });
    return [];
  }

  visitInstanceRule(ctx: pc.InstanceRuleContext): AssignmentRule | InsertRule | PathRule {
    if (ctx.fixedValueRule()) {
      return this.visitFixedValueRule(ctx.fixedValueRule());
    } else if (ctx.insertRule()) {
      return this.visitInsertRule(ctx.insertRule());
    } else if (ctx.pathRule()) {
      return this.visitPathRule(ctx.pathRule(), true);
    }
  }

  visitVsRule(ctx: pc.VsRuleContext): ValueSetComponentRule | CaretValueRule | InsertRule {
    if (ctx.vsComponent()) {
      return this.visitVsComponent(ctx.vsComponent());
    }
    if (ctx.caretValueRule()) {
      const rule = this.visitCaretValueRule(ctx.caretValueRule());
      if (ctx.caretValueRule().path()) {
        logger.error(
          'Caret rule on ValueSet cannot contain path before ^, skipping rule.',
          rule.sourceInfo
        );
      } else {
        // if this rule is indented, it may have a concept context
        // but it never needs a regular path.
        rule.path = '';
        return rule;
      }
    } else if (ctx.codeCaretValueRule()) {
      const rule = this.visitCodeCaretValueRule(ctx.codeCaretValueRule(), true);
      // the rule needs to have a caretPath, a value, and a pathArray with one element.
      // various syntax errors may lead to some of these values being missing.
      // the appropriate error has already been logged by FSHErrorHandler.
      if (rule.pathArray.length > 1) {
        logger.error(
          'Only one concept may be listed before a caret rule on a ValueSet.',
          rule.sourceInfo
        );
      } else if (rule.caretPath != null && rule.value != null) {
        return rule;
      }
    } else if (ctx.insertRule()) {
      return this.visitInsertRule(ctx.insertRule(), true);
    } else if (ctx.codeInsertRule()) {
      const rule = this.visitCodeInsertRule(ctx.codeInsertRule(), true);
      if (rule.pathArray.length > 1) {
        logger.error(
          'Only one concept may be listed before an insert rule on a ValueSet.',
          rule.sourceInfo
        );
      } else {
        return rule;
      }
    }
  }

  visitCsRule(ctx: pc.CsRuleContext): ConceptRule | CaretValueRule | InsertRule {
    if (ctx.concept()) {
      return this.visitConcept(ctx.concept());
    } else if (ctx.codeCaretValueRule()) {
      return this.visitCodeCaretValueRule(ctx.codeCaretValueRule());
    } else if (ctx.codeInsertRule()) {
      return this.visitCodeInsertRule(ctx.codeInsertRule());
    }
  }

  visitInvariantRule(ctx: pc.InvariantRuleContext): AssignmentRule | InsertRule {
    if (ctx.fixedValueRule()) {
      return this.visitFixedValueRule(ctx.fixedValueRule());
    } else if (ctx.insertRule()) {
      return this.visitInsertRule(ctx.insertRule());
    } else if (ctx.pathRule()) {
      this.visitPathRule(ctx.pathRule());
      return;
    }
  }

  visitMappingEntityRule(ctx: pc.MappingEntityRuleContext): MappingRule | InsertRule {
    if (ctx.mappingRule()) {
      return this.visitMappingRule(ctx.mappingRule());
    } else if (ctx.insertRule()) {
      return this.visitInsertRule(ctx.insertRule());
    } else if (ctx.pathRule()) {
      // A path rule may swallow a mapping rule that has no spaces, so catch that case here
      if (this.visitPath(ctx.pathRule().path()).includes('->')) {
        logger.error(
          "Mapping rules must include at least one space both before and after the '->' operator",
          {
            location: this.extractStartStop(ctx.pathRule()),
            file: this.currentFile
          }
        );
      }
      this.visitPathRule(ctx.pathRule());
      return;
    }
  }

  getPathWithContext(
    path: string,
    parentCtx: ParserRuleContext,
    isPathRule = false,
    isInstanceRule = false
  ): string {
    const splitPath = path === '.' ? [path] : splitOnPathPeriods(path).filter(p => p);
    return this.getArrayPathWithContext(splitPath, parentCtx, isPathRule, isInstanceRule).join('.');
  }

  getArrayPathWithContext(
    pathArray: string[],
    parentCtx: ParserRuleContext,
    isPathRule = false,
    isInstanceRule = false,
    suppressError = false
  ): string[] {
    return this.prependPathContext(pathArray, parentCtx, isPathRule, isInstanceRule, suppressError);
  }

  visitPath(ctx: pc.PathContext): string {
    return ctx?.getText() || '';
  }

  visitCaretPath(ctx: pc.CaretPathContext): string {
    return ctx.CARET_SEQUENCE().getText();
  }

  visitCardRule(ctx: pc.CardRuleContext): (CardRule | FlagRule)[] {
    const rules: (CardRule | FlagRule)[] = [];

    const cardRule = new CardRule(this.getPathWithContext(this.visitPath(ctx.path()), ctx))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    const card = this.parseCard(ctx.CARD().getText(), cardRule);
    cardRule.min = card.min;
    cardRule.max = card.max;
    rules.push(cardRule);

    if (ctx.flag() && ctx.flag().length > 0) {
      const flagRule = new FlagRule(cardRule.path)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      this.parseFlags(flagRule, ctx.flag());
      rules.push(flagRule);
    }
    return rules;
  }

  private parseCard(card: string, rule: CardRule | AddElementRule): { min: number; max: string } {
    const parts = card.split('..', 2);
    if (parts[0] === '' && parts[1] === '') {
      logger.error(
        `Neither side of the cardinality was specified on path "${rule.path}". A min, max, or both need to be specified.`,
        rule.sourceInfo
      );
    }
    return {
      min: parseInt(parts[0]),
      max: parts[1]
    };
  }

  visitFlagRule(ctx: pc.FlagRuleContext): FlagRule[] {
    return ctx.path().map(path => {
      const flagRule = new FlagRule(this.getPathWithContext(this.visitPath(path), ctx))
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      this.parseFlags(flagRule, ctx.flag());
      return flagRule;
    });
  }

  private parseFlags(flagRule: FlagRule | AddElementRule, flagContext: pc.FlagContext[]): void {
    const flags = flagContext.map(f => this.visitFlag(f));
    if (flags.includes(Flag.MustSupport)) {
      flagRule.mustSupport = true;
    }
    if (flags.includes(Flag.Summary)) {
      flagRule.summary = true;
    }
    if (flags.includes(Flag.Modifier)) {
      flagRule.modifier = true;
    }
    if (flags.includes(Flag.TrialUse)) {
      flagRule.trialUse = true;
    }
    if (flags.includes(Flag.Normative)) {
      flagRule.normative = true;
    }
    if (flags.includes(Flag.Draft)) {
      flagRule.draft = true;
    }
  }

  visitFlag(ctx: pc.FlagContext): Flag {
    if (ctx.KW_MS()) {
      return Flag.MustSupport;
    } else if (ctx.KW_SU()) {
      return Flag.Summary;
    } else if (ctx.KW_MOD()) {
      return Flag.Modifier;
    } else if (ctx.KW_TU()) {
      return Flag.TrialUse;
    } else if (ctx.KW_NORMATIVE()) {
      return Flag.Normative;
    } else if (ctx.KW_DRAFT()) {
      return Flag.Draft;
    }
    return Flag.Unknown;
  }

  visitValueSetRule(ctx: pc.ValueSetRuleContext): BindingRule {
    const vsRule = new BindingRule(this.getPathWithContext(this.visitPath(ctx.path()), ctx))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    vsRule.valueSet = this.aliasAwareValue(ctx.name());
    vsRule.strength = ctx.strength() ? this.visitStrength(ctx.strength()) : 'required';
    return vsRule;
  }

  visitStrength(ctx: pc.StrengthContext): string {
    if (ctx.KW_EXAMPLE()) {
      return 'example';
    } else if (ctx.KW_PREFERRED()) {
      return 'preferred';
    } else if (ctx.KW_EXTENSIBLE()) {
      return 'extensible';
    }
    return 'required';
  }

  visitFixedValueRule(ctx: pc.FixedValueRuleContext): AssignmentRule {
    const assignmentRule = new AssignmentRule(
      this.getPathWithContext(this.visitPath(ctx.path()), ctx)
    )
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    assignmentRule.value = this.visitValue(ctx.value());
    // for numbers and booleans, keep the raw value to handle cases of unusual Instance id
    if (ctx.value()?.NUMBER()) {
      assignmentRule.rawValue = ctx.value().NUMBER().getText();
    }
    if (ctx.value()?.bool()) {
      assignmentRule.rawValue = ctx.value().bool().getText();
    }
    assignmentRule.exactly = ctx.KW_EXACTLY() != null;
    assignmentRule.isInstance =
      ctx.value().name() != null && !this.allAliases.has(ctx.value().name().getText());
    return assignmentRule;
  }

  visitValue(ctx: pc.ValueContext): AssignmentValueType {
    // In cases where the parser encounters an error, ctx might be null
    if (ctx == null) {
      return;
    }

    if (ctx.name()) {
      return this.aliasAwareValue(ctx, ctx.name().getText());
    }

    if (ctx.STRING()) {
      return this.extractString(ctx.STRING());
    }

    if (ctx.MULTILINE_STRING()) {
      return this.extractMultilineString(ctx.MULTILINE_STRING());
    }

    if (ctx.NUMBER()) {
      return this.extractNumberValue(ctx.NUMBER());
    }

    if (ctx.DATETIME()) {
      // for now, treat datetime like a string
      return ctx.DATETIME().getText();
    }

    if (ctx.TIME()) {
      // for now, treat datetime like a string
      return ctx.TIME().getText();
    }

    if (ctx.reference()) {
      return this.visitReference(ctx.reference());
    }

    if (ctx.canonical()) {
      const canonicals = this.visitCanonical(ctx.canonical());
      if (canonicals.length > 1) {
        logger.error(
          'Multiple choices of canonicals are not allowed when setting a value. Only the first choice will be used.',
          {
            file: this.currentFile,
            location: this.extractStartStop(ctx.canonical())
          }
        );
      }
      return canonicals[0];
    }

    if (ctx.code()) {
      return this.visitCode(ctx.code());
    }

    if (ctx.quantity()) {
      return this.visitQuantity(ctx.quantity());
    }

    if (ctx.ratio()) {
      return this.visitRatio(ctx.ratio());
    }

    if (ctx.bool()) {
      return this.visitBool(ctx.bool());
    }
  }

  visitCode(ctx: pc.CodeContext): FshCode {
    const concept = this.parseCodeLexeme(ctx.CODE().getText(), ctx.CODE())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (ctx.STRING()) {
      concept.display = this.extractString(ctx.STRING());
    }
    return concept;
  }

  visitConcept(ctx: pc.ConceptContext): ConceptRule {
    const localCodePath = ctx
      .CODE()
      .map(codeCtx => this.parseCodeLexeme(codeCtx.getText(), codeCtx));
    // the last code in allCodes is the one we are actually defining.
    // the rest are the hierarchy, which may be empty.
    // indentation may also be used to define the hierarchy, which is what the code path with context is for.
    // the # is included in the array path since it is needed for caret rules.
    const fullCodePath = this.getArrayPathWithContext(
      localCodePath.map(localCode => `#${localCode.code}`),
      ctx
    );
    const codePart = localCodePath.slice(-1)[0];
    const availableStrings = ctx.STRING().map(strCtx => this.extractString(strCtx));
    const concept = new ConceptRule(codePart.code)
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    // concepts in the array path have a leading #, which we don't want in the hierarchy
    concept.hierarchy = fullCodePath.slice(0, -1).map(code => code.slice(1));
    if (availableStrings.length > 0) {
      concept.display = availableStrings[0];
    }
    if (availableStrings.length > 1) {
      concept.definition = availableStrings[1];
    } else if (ctx.MULTILINE_STRING()) {
      concept.definition = this.extractMultilineString(ctx.MULTILINE_STRING());
    }
    if (localCodePath.some(listedConcept => listedConcept.system)) {
      // If this concept is part of a RuleSet and has a system, no definition, and no hierarchy,
      // it might actually represent a ValueSetConceptComponent. We can't know for sure until the RuleSet
      // is inserted somewhere. For now, assume it will be okay, so keep the system for later.
      if (
        ctx.parentCtx instanceof FSHParser.RuleSetRuleContext &&
        codePart.system &&
        !concept.definition &&
        concept.hierarchy.length === 0
      ) {
        concept.system = codePart.system;
      } else {
        logger.error(
          'Do not include the system when listing concepts for a code system.',
          concept.sourceInfo
        );
      }
    }
    return concept;
  }

  visitQuantity(ctx: pc.QuantityContext): FshQuantity {
    let value = null;
    if (ctx.NUMBER()) {
      value = parseFloat(ctx.NUMBER().getText());
    }
    let delimitedUnit = ctx.UNIT() ? ctx.UNIT().getText() : ''; // e.g., 'mm'
    // We'll want to assume the UCUM code system unless another system is specified
    let unitSystem = 'http://unitsofmeasure.org';
    // If there's no unit string, then we're using FSHCode syntax
    if (!delimitedUnit) {
      const unitCode = this.parseCodeLexeme(ctx.CODE().getText(), ctx.CODE())
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      unitSystem = unitCode.system;
      delimitedUnit = unitCode.code;
    } else {
      delimitedUnit = delimitedUnit.slice(1, -1);
    }
    let displayUnit: string;
    if (ctx.STRING()) {
      displayUnit = this.extractString(ctx.STRING());
    }
    const unit = new FshCode(delimitedUnit, unitSystem, displayUnit)
      .withLocation(this.extractStartStop(ctx.UNIT() ? ctx.UNIT() : ctx))
      .withFile(this.currentFile);
    const quantity = new FshQuantity(value, unit)
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    return quantity;
  }

  visitRatio(ctx: pc.RatioContext): FshRatio {
    const ratio = new FshRatio(
      this.visitRatioPart(ctx.ratioPart()[0]),
      this.visitRatioPart(ctx.ratioPart()[1])
    )
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    return ratio;
  }

  visitRatioPart(ctx: pc.RatioPartContext): FshQuantity {
    if (ctx.NUMBER()) {
      const quantity = new FshQuantity(parseFloat(ctx.NUMBER().getText()))
        .withLocation(this.extractStartStop(ctx.NUMBER()))
        .withFile(this.currentFile);
      return quantity;
    }
    return this.visitQuantity(ctx.quantity());
  }

  // This function is called when fixing a value, and a value can only be set
  // to a specific reference, not a choice of references.
  visitReference(ctx: pc.ReferenceContext): FshReference {
    const parsedReferences = this.parseOrReference(ctx.REFERENCE().getText());
    const ref = new FshReference(this.aliasAwareValue(ctx.REFERENCE(), parsedReferences[0]));
    if (parsedReferences.length > 1) {
      logger.error(
        'Multiple choices of references are not allowed when setting a value. Only the first choice will be used.',
        {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        }
      );
    }
    ref.withLocation(this.extractStartStop(ctx)).withFile(this.currentFile);
    if (ctx.STRING()) {
      ref.display = this.extractString(ctx.STRING());
    }
    return ref;
  }

  private parseOrReference(reference: string): string[] {
    return reference
      .slice(reference.indexOf('(') + 1, reference.length - 1)
      .split(/\s+or\s+/)
      .map(r => r.trim());
  }

  visitCanonical(ctx: pc.CanonicalContext): FshCanonical[] {
    const canonicalText = ctx.CANONICAL().getText();
    const choices = canonicalText
      .slice(canonicalText.indexOf('(') + 1, canonicalText.length - 1)
      .split(/\s+or\s+/)
      .map(r => r.trim());

    return choices.map(c => {
      const [item, version] = c.split(/\s*\|\s*(.+)/).map(str => str.trim());
      const fshCanonical = new FshCanonical(item)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      if (version) {
        fshCanonical.version = version;
      }
      return fshCanonical;
    });
  }

  visitBool(ctx: pc.BoolContext): boolean {
    return ctx.KW_TRUE() != null;
  }

  visitOnlyRule(ctx: pc.OnlyRuleContext): OnlyRule {
    const onlyRule = new OnlyRule(this.getPathWithContext(this.visitPath(ctx.path()), ctx))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);

    onlyRule.types = this.parseTargetType(ctx);
    return onlyRule;
  }

  private parseTargetType(ctx: pc.AddElementRuleContext | pc.OnlyRuleContext): OnlyRuleType[] {
    const orTypes: OnlyRuleType[] = [];
    ctx.targetType().forEach(t => {
      if (t.referenceType()) {
        const referenceToken = t.referenceType().REFERENCE();
        const references = this.parseOrReference(referenceToken.getText());
        references.forEach(r =>
          orTypes.push({
            type: this.aliasAwareValue(referenceToken, r),
            isReference: true
          })
        );
      } else if (t.codeableReferenceType()) {
        const codeableReferenceToken = t.codeableReferenceType().CODEABLE_REFERENCE();
        const codeableReferences = this.parseOrReference(codeableReferenceToken.getText());
        codeableReferences.forEach(r =>
          orTypes.push({
            type: this.aliasAwareValue(codeableReferenceToken, r),
            isCodeableReference: true
          })
        );
      } else if (t.canonical()) {
        const canonicals = this.visitCanonical(t.canonical());
        canonicals.forEach(c =>
          orTypes.push({
            type: `${this.aliasAwareValue(t.canonical(), c.entityName)}${
              c.version ? `|${c.version}` : ''
            }`,
            isCanonical: true
          })
        );
      } else {
        orTypes.push({ type: this.aliasAwareValue(t.name()) });
      }
    });
    return orTypes;
  }

  visitContainsRule(ctx: pc.ContainsRuleContext): (ContainsRule | CardRule | FlagRule)[] {
    const rules: (ContainsRule | CardRule | FlagRule)[] = [];
    const containsRule = new ContainsRule(this.getPathWithContext(this.visitPath(ctx.path()), ctx))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);

    rules.push(containsRule);
    ctx.item().forEach(i => {
      let item: ContainsRuleItem;
      if (i.KW_NAMED()) {
        item = {
          type: this.aliasAwareValue(i.name()[0], i.name()[0].getText()),
          name: i.name()[1].getText()
        };
      } else {
        item = {
          name: i.name()[0].getText()
        };
      }
      containsRule.items.push(item);

      const cardRule = new CardRule(`${containsRule.path}[${item.name}]`)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      const card = this.parseCard(i.CARD().getText(), cardRule);
      cardRule.min = card.min;
      cardRule.max = card.max;
      rules.push(cardRule);

      if (i.flag() && i.flag().length > 0) {
        const flagRule = new FlagRule(`${containsRule.path}[${item.name}]`)
          .withLocation(this.extractStartStop(ctx))
          .withFile(this.currentFile);
        this.parseFlags(flagRule, i.flag());
        rules.push(flagRule);
      }
    });
    return rules;
  }

  visitCaretValueRule(ctx: pc.CaretValueRuleContext): CaretValueRule {
    const path = this.visitPath(ctx.path());
    const splitPath = path === '.' ? [path] : splitOnPathPeriods(path).filter(p => p);
    const pathArray = this.getArrayPathWithContext(splitPath, ctx);
    const caretValueRule = new CaretValueRule(pathArray.join('.'))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    // We must save the path in array form, in case this rule is a part
    // of a RuleSet which ends up applied on a CodeSystem
    caretValueRule.pathArray = pathArray;
    // Get the caret path, but slice off the starting ^
    caretValueRule.caretPath = this.visitCaretPath(ctx.caretPath()).slice(1);
    caretValueRule.value = this.visitValue(ctx.value());
    // for numbers and booleans, keep the raw value to handle cases of unusual Instance id
    if (ctx.value()?.NUMBER()) {
      caretValueRule.rawValue = ctx.value().NUMBER().getText();
    }
    if (ctx.value()?.bool()) {
      caretValueRule.rawValue = ctx.value().bool().getText();
    }
    caretValueRule.isInstance =
      ctx.value()?.name() != null && !this.allAliases.has(ctx.value().name().getText());
    return caretValueRule;
  }

  // when parsing a ValueSet, we need to keep the system.
  // in all other cases, the system is not needed.
  visitCodeCaretValueRule(ctx: pc.CodeCaretValueRuleContext, keepSystem = false): CaretValueRule {
    const localCodePath = ctx.CODE()
      ? ctx.CODE().map(code => {
          const parsedCode = this.parseCodeLexeme(code.getText(), ctx);
          if (keepSystem) {
            return `${parsedCode.system ?? ''}#${parsedCode.code}`;
          } else {
            return `#${parsedCode.code}`;
          }
        })
      : [];
    const fullCodePath = this.getArrayPathWithContext(localCodePath, ctx);
    // It's fine to make a CodeCaretValueRule with an empty code path.
    const caretRule = new CaretValueRule('')
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    caretRule.pathArray = fullCodePath;
    // Get the caret path, but slice off the starting ^
    caretRule.caretPath = this.visitCaretPath(ctx.caretPath())?.slice(1);
    caretRule.value = this.visitValue(ctx.value());
    // for numbers and booleans, keep the raw value to handle cases where an Instance id looks like a number
    if (ctx.value()?.NUMBER()) {
      caretRule.rawValue = ctx.value().NUMBER().getText();
    }
    if (ctx.value()?.bool()) {
      caretRule.rawValue = ctx.value().bool().getText();
    }
    caretRule.isInstance =
      ctx.value()?.name() != null && !this.allAliases.has(ctx.value().name().getText());
    return caretRule;
  }

  visitObeysRule(ctx: pc.ObeysRuleContext): ObeysRule[] {
    const rules: ObeysRule[] = [];
    const path = this.getPathWithContext(this.visitPath(ctx.path()), ctx);
    ctx.name().forEach(invariant => {
      const obeysRule = new ObeysRule(path)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      obeysRule.invariant = invariant.getText();
      rules.push(obeysRule);
    });
    return rules;
  }

  visitPathRule(ctx: pc.PathRuleContext, isInstanceRule = false): PathRule {
    const pathRule = new PathRule(
      this.getPathWithContext(this.visitPath(ctx.path()), ctx, true, isInstanceRule)
    )
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    return pathRule;
  }

  // when parsing a ValueSet, we need to keep the system.
  // in all other cases, the system is not needed.
  visitCodeInsertRule(ctx: pc.CodeInsertRuleContext, keepSystem = false): InsertRule {
    const insertRule = new InsertRule('')
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    const localCodePath = ctx.CODE().map(code => {
      const parsedCode = this.parseCodeLexeme(code.getText(), ctx);
      if (keepSystem) {
        return `${parsedCode.system ?? ''}#${parsedCode.code}`;
      } else {
        return `#${parsedCode.code}`;
      }
    });
    const fullCodePath = this.getArrayPathWithContext(localCodePath, ctx);
    insertRule.pathArray = fullCodePath;
    return this.applyRuleSetParams(ctx, insertRule);
  }

  visitInsertRule(ctx: pc.InsertRuleContext, withPathArray = false): InsertRule {
    const localPath = this.visitPath(ctx.path());
    const fullPathArray = this.getArrayPathWithContext(localPath === '' ? [] : [localPath], ctx);
    const insertRule = new InsertRule(fullPathArray.join('.'))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (withPathArray) {
      insertRule.pathArray = fullPathArray;
    }
    return this.applyRuleSetParams(ctx, insertRule);
  }

  private parseRuleSetReference(ctx: pc.ParamRuleSetRefContext): {
    name: string;
    params: string[];
  } {
    const ruleSetName = ctx.PARAM_RULESET_REFERENCE().getText().slice(0, -1).trim();
    const ruleSetParams = [...ctx.parameter(), ctx.lastParameter()].map(param =>
      param.getText().slice(0, -1).trim()
    );
    return { name: ruleSetName, params: ruleSetParams };
  }

  private parseInsertRuleParams(ctx: pc.ParamRuleSetRefContext): string[] {
    const headParams = ctx.parameter().map(param => {
      if (param.BRACKETED_PARAM()) {
        // trim off the brackets and comma, and unescape literal ]], and ]])
        return param
          .BRACKETED_PARAM()
          .getText()
          .slice(0, -1) // slice off trailing comma
          .trim()
          .slice(2, -2) // slice off leading/trailing brackets
          .replace(/(\]\]\s*)\\([,\)])|(\\\\)/g, '$1$2$3');
      } else {
        // trim off the trailing comma, and unescape , and )
        return param
          .PLAIN_PARAM()
          .getText()
          .slice(0, -1)
          .trim()
          .replace(/\\([,\)])/g, '$1');
      }
    });
    let tailParam: string;
    if (ctx.lastParameter().LAST_BRACKETED_PARAM()) {
      // trim off the brackets and right parentheses, and unescape literal ]], and ]])
      tailParam = ctx
        .lastParameter()
        .LAST_BRACKETED_PARAM()
        .getText()
        .slice(0, -1) // slice off trailing right parentheses
        .trim()
        .slice(2, -2) // slice off leading/trailing brackets
        .replace(/(\]\]\s*)\\([,\)])|(\\\\)/g, '$1$2$3');
    } else {
      // trim off the trailing right parentheses, and unescape , and )
      tailParam = ctx
        .lastParameter()
        .LAST_PLAIN_PARAM()
        .getText()
        .slice(0, -1)
        .trim()
        .replace(/\\([,\)])/g, '$1');
    }
    return [...headParams, tailParam];
  }

  private applyRuleSetParams(
    ctx: pc.InsertRuleContext | pc.CodeInsertRuleContext,
    insertRule: InsertRule
  ): InsertRule {
    let name: string;
    let params: string[];
    if (ctx.paramRuleSetRef()) {
      const parsedInfo = this.parseRuleSetReference(ctx.paramRuleSetRef());
      name = parsedInfo.name;
      params = this.parseInsertRuleParams(ctx.paramRuleSetRef());
    } else {
      name = ctx.RULESET_REFERENCE().getText().trim();
    }

    insertRule.ruleSet = name;
    if (params) {
      insertRule.params = params;
      const ruleSet = this.paramRuleSets.get(insertRule.ruleSet);
      if (ruleSet) {
        const ruleSetIdentifier = JSON.stringify([ruleSet.name, ...insertRule.params]);
        if (ruleSet.parameters.length === insertRule.params.length) {
          // no need to create the appliedRuleSet again if we already have it
          if (!this.currentDoc.appliedRuleSets.has(ruleSetIdentifier)) {
            // create a new document with the substituted parameters
            const appliedFsh = applyRuleSetSubstitutions(ruleSet, insertRule.params);
            const appliedRuleSet = this.parseGeneratedRuleSet(appliedFsh, ruleSet.name, insertRule);
            if (appliedRuleSet) {
              // set the source info based on the original source info
              appliedRuleSet.sourceInfo.file = ruleSet.sourceInfo.file;
              appliedRuleSet.sourceInfo.location = { ...ruleSet.sourceInfo.location };
              appliedRuleSet.rules.forEach(rule => {
                rule.sourceInfo.file = appliedRuleSet.sourceInfo.file;
                rule.sourceInfo.location.startLine +=
                  appliedRuleSet.sourceInfo.location.startLine - 1;
                rule.sourceInfo.location.endLine +=
                  appliedRuleSet.sourceInfo.location.startLine - 1;
              });
              this.currentDoc.appliedRuleSets.set(ruleSetIdentifier, appliedRuleSet);
            } else {
              logger.error(
                `Failed to parse RuleSet ${
                  insertRule.ruleSet
                } with provided parameters (${insertRule.params.join(', ')})`,
                insertRule.sourceInfo
              );
              return;
            }
          }
        } else {
          logger.error(
            `Incorrect number of parameters applied to RuleSet ${insertRule.ruleSet}`,
            insertRule.sourceInfo
          );
          return;
        }
      } else {
        logger.error(
          `Could not find parameterized RuleSet named ${insertRule.ruleSet}`,
          insertRule.sourceInfo
        );
        return;
      }
    }
    return insertRule;
  }

  private parseGeneratedRuleSet(input: string, name: string, insertRule: InsertRule) {
    // define a temporary document that will contain this RuleSet
    const tempDocument = new FSHDocument(this.currentFile);
    // save the currentDoc so it can be restored after parsing this RuleSet
    const parentDocument = this.currentDoc;
    const parentContext = this.pathContext;
    this.currentDoc = tempDocument;
    // errors should be collected, not printed, when parsing generated documents
    // we should only retrieve errors if we are currently in the top-level parse
    let topLevelInfo: LoggerData;
    if (this.topLevelParse) {
      this.topLevelParse = false;
      topLevelInfo = switchToSecretLogger();
    }
    try {
      const subContext = this.parseDoc(input);
      this.visitDoc(subContext);
    } finally {
      // be sure to restore parentDocument
      this.currentDoc = parentDocument;
      this.pathContext = parentContext;
    }
    // if tempDocument has appliedRuleSets, merge them in
    tempDocument.appliedRuleSets.forEach((ruleSet, identifier) =>
      this.currentDoc.appliedRuleSets.set(identifier, ruleSet)
    );
    if (topLevelInfo) {
      // exit logger collection mode, write collected errors and warnings
      const collectedMessages = restoreMainLogger(topLevelInfo);
      this.topLevelParse = true;
      if (collectedMessages.errors.length > 0) {
        logger.error(
          [
            `Error${
              collectedMessages.errors.length > 1 ? 's' : ''
            } parsing insert rule with parameterized RuleSet ${name}`,
            ...collectedMessages.errors.map(log => `- ${log.message}`)
          ].join(EOL),
          insertRule.sourceInfo
        );
      }
      if (collectedMessages.warnings.length > 0) {
        logger.warn(
          [
            `Warning${
              collectedMessages.warnings.length > 1 ? 's' : ''
            } parsing insert rule with parameterized RuleSet ${name}`,
            ...collectedMessages.warnings.map(log => `- ${log.message}`)
          ].join(EOL),
          insertRule.sourceInfo
        );
      }
    }
    // if the RuleSet parsed successfully, it will be on the document, and we should return it.
    return tempDocument.ruleSets.get(name);
  }

  visitMappingRule(ctx: pc.MappingRuleContext): MappingRule {
    const mappingRule = new MappingRule(this.getPathWithContext(this.visitPath(ctx.path()), ctx))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    mappingRule.map = this.extractString(ctx.STRING()[0]);
    if (ctx.STRING().length > 1) {
      mappingRule.comment = this.extractString(ctx.STRING()[1]);
    }
    if (ctx.CODE()) {
      mappingRule.language = this.parseCodeLexeme(ctx.CODE().getText(), ctx.CODE())
        .withLocation(this.extractStartStop(ctx.CODE()))
        .withFile(this.currentFile);
      if (mappingRule.language.system?.length > 0) {
        logger.warn(
          'Do not specify a system for mapping language.',
          mappingRule.language.sourceInfo
        );
      }
    }
    return mappingRule;
  }

  visitVsComponent(ctx: pc.VsComponentContext): ValueSetComponentRule {
    const inclusion = ctx.KW_EXCLUDE() == null;
    let vsComponent: ValueSetConceptComponentRule | ValueSetFilterComponentRule;
    if (ctx.vsConceptComponent()) {
      vsComponent = new ValueSetConceptComponentRule(inclusion)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      [vsComponent.concepts, vsComponent.from] = this.visitVsConceptComponent(
        ctx.vsConceptComponent()
      );
      if (vsComponent.concepts.length === 1) {
        // set context... but if this is indented, this will produce the "don't indent me" error a second time
        // so, we set a flag to tell it to not produce that error.
        this.getArrayPathWithContext(
          [`${vsComponent.concepts[0].system}#${vsComponent.concepts[0].code}`],
          ctx,
          false,
          false,
          true
        );
      } else {
        // reset the context
        this.getArrayPathWithContext([], ctx, false, false, true);
      }
    } else if (ctx.vsFilterComponent()) {
      vsComponent = new ValueSetFilterComponentRule(inclusion)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      [vsComponent.filters, vsComponent.from] = this.visitVsFilterComponent(
        ctx.vsFilterComponent()
      );
      // reset the context
      this.getArrayPathWithContext([], ctx, false, false, true);
    }
    return vsComponent;
  }

  visitVsConceptComponent(ctx: pc.VsConceptComponentContext): [FshCode[], ValueSetComponentFrom] {
    const concepts: FshCode[] = [];
    const from: ValueSetComponentFrom = ctx.vsComponentFrom()
      ? this.visitVsComponentFrom(ctx.vsComponentFrom())
      : {};
    const singleCode = this.visitCode(ctx.code());
    if (singleCode.system && from.system) {
      logger.error(`Concept ${singleCode.code} specifies system multiple times`, {
        file: this.currentFile,
        location: this.extractStartStop(ctx)
      });
    } else if (singleCode.system) {
      from.system = singleCode.system;
      concepts.push(singleCode);
    } else if (from.system) {
      singleCode.system = from.system;
      concepts.push(singleCode);
    } else {
      logger.error(
        `Concept ${singleCode.code} must include system as "SYSTEM#CONCEPT" or "#CONCEPT from system SYSTEM"`,
        {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        }
      );
    }
    return [concepts, from];
  }

  visitVsFilterComponent(
    ctx: pc.VsFilterComponentContext
  ): [ValueSetFilter[], ValueSetComponentFrom] {
    const filters: ValueSetFilter[] = [];
    const from: ValueSetComponentFrom = ctx.vsComponentFrom()
      ? this.visitVsComponentFrom(ctx.vsComponentFrom())
      : {};
    if (ctx.vsFilterList()) {
      if (from.system) {
        ctx
          .vsFilterList()
          .vsFilterDefinition()
          .forEach(filterDefinition => {
            try {
              filters.push(this.visitVsFilterDefinition(filterDefinition));
            } catch (e) {
              logger.error(e, {
                location: this.extractStartStop(filterDefinition),
                file: this.currentFile
              });
            }
          });
      } else {
        logger.error('System is required when filtering a value set component', {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        });
      }
    }
    return [filters, from];
  }

  visitVsComponentFrom(ctx: pc.VsComponentFromContext): ValueSetComponentFrom {
    const from: ValueSetComponentFrom = {};
    if (ctx.vsFromSystem()) {
      from.system = this.aliasAwareValue(ctx.vsFromSystem().name());
    }
    if (ctx.vsFromValueset()) {
      if (ctx.vsFromValueset().name().length > 0) {
        from.valueSets = ctx
          .vsFromValueset()
          .name()
          .map(name => this.aliasAwareValue(name));
      }
    }
    return from;
  }

  /**
   * The replace makes FSH permissive in regards to the official specifications,
   * which spells operator "descendant-of" as "descendent-of".
   * @see {@link http://hl7.org/fhir/valueset-filter-operator.html}
   */
  visitVsFilterDefinition(ctx: pc.VsFilterDefinitionContext): ValueSetFilter {
    const property = ctx.name().getText();
    const operator = ctx
      .vsFilterOperator()
      .getText()
      .toLocaleLowerCase()
      .replace('descendant', 'descendent') as VsOperator;
    if (ctx.vsFilterValue() == null && operator !== VsOperator.EXISTS) {
      throw new ValueSetFilterMissingValueError(operator);
    }
    const value = ctx.vsFilterValue() ? this.visitVsFilterValue(ctx.vsFilterValue()) : true;

    // NOTE: We support string value for every operator, in addition to the specific typed values
    // for some operators based on the filter value documentation:
    // http://hl7.org/fhir/R4/valueset-definitions.html#ValueSet.compose.include.filter.value
    // and the discussion on https://github.com/FHIR/sushi/issues/936
    switch (operator) {
      case VsOperator.EQUALS:
      case VsOperator.IN:
      case VsOperator.NOT_IN:
      case VsOperator.IS_A:
      case VsOperator.DESCENDENT_OF:
      case VsOperator.IS_NOT_A:
      case VsOperator.GENERALIZES:
        if (!(value instanceof FshCode) && typeof value !== 'string') {
          throw new ValueSetFilterValueTypeError(operator, ['code', 'string']);
        }
        break;
      case VsOperator.REGEX:
        if (!(value instanceof RegExp) && typeof value !== 'string') {
          throw new ValueSetFilterValueTypeError(operator, ['regex', 'string']);
        }
        break;
      case VsOperator.EXISTS:
        const allowedStrings = ['true', 'false'];
        if (
          typeof value !== 'boolean' &&
          !(typeof value === 'string' && allowedStrings.includes(value))
        ) {
          throw new ValueSetFilterValueTypeError(operator, ['boolean'], allowedStrings);
        }
        break;
      default:
        throw new ValueSetFilterOperatorError(ctx.vsFilterOperator().getText());
    }
    return {
      property: property,
      operator: operator,
      value: value
    };
  }

  visitVsFilterValue(ctx: pc.VsFilterValueContext): ValueSetFilterValue {
    if (ctx.code()) {
      return this.visitCode(ctx.code());
    } else if (ctx.REGEX()) {
      return RegExp(ctx.REGEX().getText().slice(1, -1));
    } else if (ctx.STRING()) {
      return this.extractString(ctx.STRING());
    } else if (ctx.KW_TRUE()) {
      return true;
    } else if (ctx.KW_FALSE()) {
      return false;
    }
  }

  private validateAliasResolves(parentCtx: ParserRuleContext, value = parentCtx.getText()): void {
    const hasAlias = this.allAliases.has(value);
    if (!hasAlias && value.startsWith('$')) {
      logger.error(
        `Value ${value} does not resolve as alias, values beginning with "$" must resolve`,
        { location: this.extractStartStop(parentCtx), file: this.currentFile }
      );
    }
  }

  private aliasAwareValue(parentCtx: ParserRuleContext, value = parentCtx.getText()): string {
    const [valueWithoutVersion, version] = value.split('|');
    this.validateAliasResolves(parentCtx, valueWithoutVersion);
    if (this.allAliases.has(valueWithoutVersion)) {
      return this.allAliases.get(valueWithoutVersion) + (version ? `|${version}` : '');
    } else {
      return value;
    }
  }

  /**
   * Given a path and the context containing it, apply the path context indicated by the path's indent
   * @param path - The path to apply context to
   * @param parentCtx - The parent element containing the path
   * @returns {string[]} - The path with context prepended
   */
  private prependPathContext(
    path: string[],
    parentCtx: ParserRuleContext,
    isPathRule: boolean,
    isInstanceRule: boolean,
    suppressError: boolean
  ): string[] {
    try {
      const location = this.extractStartStop(parentCtx, suppressError);
      const currentIndent = location.startColumn - DEFAULT_START_COLUMN;
      const contextIndex = currentIndent / INDENT_WIDTH;

      if (!this.isValidContext(location, currentIndent, this.pathContext)) {
        return path;
      }

      // If the element is not indented, just reset the context
      if (contextIndex === 0) {
        // If the last context still has [+], that means the path was never used
        // and the [+] will be discarded without incrementing
        if (
          this.pathContext.length > 0 &&
          this.pathContext[this.pathContext.length - 1].some(p => /\[\+\]/.test(p))
        ) {
          logger.warn(
            'The previous line(s) use path rules to establish a context using soft indexing ' +
              '(e.g., [+]), but that context is reset by the following rule before it is ever ' +
              'used. As a result, the previous path context will be ignored and its ' +
              'soft-indices will not be incremented',
            {
              location,
              file: this.currentFile
            }
          );
        }
        this.pathContext = [path];
        return path;
      }

      if (path.length === 1 && path[0] === '.') {
        logger.error(
          "The special '.' path is only allowed in top-level rules. The rule will be processed as if it is not indented.",
          {
            location,
            file: this.currentFile
          }
        );
        return path;
      }

      // Otherwise, get the context based on the indent level.
      const currentContext = this.pathContext[contextIndex - 1];
      if (currentContext.length === 0 && !suppressError) {
        logger.error(
          'Rule cannot be indented below rule which has no path. The rule will be processed as if it is not indented.',
          { location, file: this.currentFile }
        );
        return path;
      }

      // Trim out-of-scope contexts
      this.pathContext.splice(contextIndex);

      // Get the new path and add as the last context
      const fullPath = currentContext.concat(path);
      this.pathContext.push(fullPath);

      return fullPath;
    } finally {
      // NOTE: This block is in finally so it is always executed, no matter where/when we exit the function
      // Once we have used the existing context in a non-path rule or any rule (including path rules) on an Instance,
      // replace [+] with [=] in all existing contexts so that the [+] isn't re-applied in further contexts
      if (!isPathRule || (isPathRule && isInstanceRule)) {
        this.pathContext.forEach((path, i) => {
          this.pathContext[i] = path.map(c => c.replace(/\[\+\]/g, '[=]'));
        });
      }
    }
  }

  private isValidContext(
    location: TextLocation,
    currentIndent: number,
    existingContext: string[] | string[][]
  ): boolean {
    if (currentIndent > 0 && existingContext.length === 0) {
      logger.error(
        'The first rule of a definition must be left-aligned. The rule will be processed as if it is not indented.',
        { location, file: this.currentFile }
      );
      return false;
    }

    if (currentIndent % INDENT_WIDTH !== 0 || currentIndent < 0) {
      logger.error(
        `Unable to determine path context for rule indented ${currentIndent} space(s). Rules must be indented in multiples of ${INDENT_WIDTH} space(s).`,
        { location, file: this.currentFile }
      );
      return false;
    }

    // And we require that rules are not indented too deeply
    const contextIndex = currentIndent / INDENT_WIDTH;
    if (contextIndex > existingContext.length) {
      logger.error(
        `Cannot determine path context of rule since it is indented too deeply. Rules must be indented in increments of ${INDENT_WIDTH} space(s).`,
        { location, file: this.currentFile }
      );
      return false;
    }
    return true;
  }

  private extractString(stringCtx: ParserRuleContext): string {
    const str = stringCtx?.getText() ?? '""'; // default to empty string if stringCtx is null
    return this.unescapeQuotedString(str);
  }

  private unescapeQuotedString(str: string): string {
    const strNoQuotes = str.slice(1, str.length - 1); // Strip surrounding quotes

    // Replace escaped characters
    const splitBackslash = strNoQuotes.split(/\\\\/g);
    const replacedBackslash = splitBackslash.map(substrBackslash => {
      // Replace quote, newline, return, tab characters only if they were not preceded by a backslash to escape the escape character
      return substrBackslash
        .replace(/\\(u[A-F,a-f,0-9]{4})/g, unescapeUnicode)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
    });
    return replacedBackslash.join('\\');
  }

  /**
   * Multiline strings receive special handling:
   * - if the first line contains only whitespace (including newline), toss it
   * - if the last line contains only whitespace (including newline), toss it
   * - if another line contains only whitespace, truncate it
   * - for all other non-whitespace lines, detect the shortest number of leading spaces and always trim that off;
   *   this allows authors to indent a whole block of text, but not have it indented in the output.
   */
  private extractMultilineString(mlStringCtx: ParserRuleContext): string {
    let mlstr = mlStringCtx.getText();

    // remove leading/trailing """
    mlstr = mlstr.slice(3, -3);

    // split into lines so we can process them to determine what leading spaces to trim
    let lines = mlstr.split(/\r?\n/);

    lines = lines.map(
      l =>
        (l = l
          .replace(/\\(u[A-F,a-f,0-9]{4})/g, unescapeUnicode)
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t'))
    );

    // if the first line is only whitespace, remove it
    if (lines[0].search(/\S/) === -1) {
      lines.shift();
    }

    // if the last line is only whitespace, remove it
    if (lines.length > 0 && lines[lines.length - 1].search(/\S/) === -1) {
      lines.pop();
    }

    lines = lines.map(l => (/^\s*$/.test(l) ? '' : l));

    // find the minimum number of spaces before the first char (ignore zero-length lines)
    const minSpaces = _min(
      lines.map(line => {
        const firstNonSpace = line.search(/\S|$/);
        const lineIsEmpty = /^$/.test(line);
        if (!lineIsEmpty) {
          return firstNonSpace;
        } else {
          return null;
        }
      })
    );

    // consistently remove the common leading spaces and join the lines back together
    return lines.map(l => (l.length >= minSpaces ? l.slice(minSpaces) : l)).join('\n');
  }

  private extractNumberValue(numberCtx: ParserRuleContext): number | bigint {
    const numberString = numberCtx.getText();
    // If the number is an integer, store it as a bigint, as a FHIR integer64 may be larger
    // than an integer we can safely store as a number
    const numberSplitter = /([-+]?\d+)(\.\d+)?([eE][-+]?\d+)?/;
    const [, wholePart, decimalPart, exponentPart] = numberString.match(numberSplitter) ?? [];
    const exponentValue = exponentPart ? parseInt(exponentPart.slice(1)) : 0;
    if (decimalPart) {
      const decimalTrimmer = /\.(\d*[1-9])0*/;
      const [, trimmedDecimal] = decimalPart.match(decimalTrimmer) ?? [];
      if (trimmedDecimal) {
        if (trimmedDecimal.length <= exponentValue) {
          return (
            BigInt(`${wholePart}${trimmedDecimal}`) *
            BigInt(10) ** BigInt(exponentValue - trimmedDecimal.length)
          );
        } else {
          return parseFloat(numberString);
        }
      }
    }
    // there's no decimal part (or it is all zeroes). a negative exponent might make this a float, but it might not.
    const wholeZeroCatcher = /[-+]?\d*[1-9](0*)/;
    const [, wholeZeroes] = wholePart.match(wholeZeroCatcher) ?? [];
    const wholeZeroCount = wholeZeroes?.length ?? 0;
    const remainingZeroes = wholeZeroCount + exponentValue;
    if (remainingZeroes >= 0) {
      if (exponentValue < 0) {
        return BigInt(wholePart) / BigInt(10) ** BigInt(exponentValue * -1);
      } else {
        return BigInt(wholePart) * BigInt(10) ** BigInt(exponentValue);
      }
    } else {
      return parseFloat(numberString);
    }
  }

  private extractStartStop(ctx: ParserRuleContext, suppressError = false): TextLocation {
    if (pc.isStarContext(ctx)) {
      const location = {
        startLine: ctx.STAR().symbol.line + 1,
        startColumn: this.getStarContextStartColumn(ctx),
        endLine: ctx.stop.line,
        endColumn: ctx.stop.stop - ctx.stop.start + ctx.stop.column + 1
      };
      if (
        !suppressError &&
        !(pc.containsPathContext(ctx) || pc.containsCodePathContext(ctx)) &&
        location.startColumn - DEFAULT_START_COLUMN > 0
      ) {
        logger.error(
          'A rule that does not use a path cannot be indented to indicate context. The rule will be processed as if it is not indented.',
          { location, file: this.currentFile }
        );
      }
      return location;
    } else if (ctx instanceof TerminalNode) {
      return {
        startLine: ctx.symbol.line,
        startColumn: ctx.symbol.column + 1,
        endLine: ctx.symbol.line,
        endColumn: ctx.symbol.stop - ctx.symbol.start + ctx.symbol.column + 1
      };
    } else {
      return {
        startLine: ctx.start.line,
        startColumn: ctx.start.column + 1,
        endLine: ctx.stop.line,
        endColumn: ctx.stop.stop - ctx.stop.start + ctx.stop.column + 1
      };
    }
  }

  private getStarContextStartColumn(ctx: pc.StarContext): number {
    return ctx.STAR().getText().length - ctx.STAR().getText().lastIndexOf('\n') - 2;
  }

  // NOTE: Since the ANTLR parser/lexer is JS (not typescript), we need to use some ts-ignore here.
  private parseDoc(input: string, file?: string): pc.DocContext {
    const chars = new InputStream(input);
    const lexer = new FSHLexer(chars);
    const listener = new FSHErrorListener(file);
    // @ts-ignore
    lexer.removeErrorListeners();
    // @ts-ignore
    lexer.addErrorListener(listener);
    // @ts-ignore
    const tokens = new CommonTokenStream(lexer);
    const parser = new FSHParser(tokens);
    // @ts-ignore
    parser.removeErrorListeners();
    // @ts-ignore
    parser.addErrorListener(listener);
    // @ts-ignore
    parser.buildParseTrees = true;
    // @ts-ignore
    return parser.doc() as DocContext;
  }
}
