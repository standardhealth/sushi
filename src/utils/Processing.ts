import path from 'path';
import process from 'process';
import fs from 'fs-extra';
import readlineSync from 'readline-sync';
import YAML from 'yaml';
import { execSync } from 'child_process';
import { YAMLMap, Collection } from 'yaml/types';
import { isPlainObject, padEnd, startCase, sortBy, upperFirst } from 'lodash';
import { EOL } from 'os';
import table from 'text-table';
import { OptionValues } from 'commander';
import { logger, logMessage } from './FSHLogger';
import { FHIRDefinitions, R5_DEFINITIONS_NEEDED_IN_R4 } from '../fhirdefs';
import {
  FSHTank,
  RawFSH,
  importText,
  ensureConfiguration,
  importConfiguration,
  loadConfigurationFromIgResource
} from '../import';
import { Package } from '../export';
import { Configuration } from '../fshtypes';
import { axiosGet } from './axiosUtils';
import { ImplementationGuideDependsOn } from '../fhirtypes';
import { FHIRVersionName, getFHIRVersionInfo } from '../utils/FHIRVersionUtils';
import { InMemoryVirtualPackage, RegistryClient } from 'fhir-package-loader';

const EXT_PKG_TO_FHIR_PKG_MAP: { [key: string]: string } = {
  'hl7.fhir.extensions.r2': 'hl7.fhir.r2.core#1.0.2',
  'hl7.fhir.extensions.r3': 'hl7.fhir.r3.core#3.0.2',
  'hl7.fhir.extensions.r4': 'hl7.fhir.r4.core#4.0.1',
  'hl7.fhir.extensions.r5': 'hl7.fhir.r5.core#5.0.0'
};

type AutomaticDependency = {
  packageId: string;
  version: string;
  fhirVersions?: FHIRVersionName[];
};

type FshFhirMapping = {
  fshFile: string;
  fshName: string;
  fshType: string;
  startLine: number;
  endLine: number;
  outputFile: string;
};

// For some context on implicit packages, see: https://chat.fhir.org/#narrow/stream/179239-tooling/topic/New.20Implicit.20Package/near/325318949
export const AUTOMATIC_DEPENDENCIES: AutomaticDependency[] = [
  {
    packageId: 'hl7.fhir.uv.tools.r4',
    version: 'latest',
    fhirVersions: ['R4', 'R4B']
  },
  {
    packageId: 'hl7.fhir.uv.tools.r5',
    version: 'latest',
    fhirVersions: ['R5', 'R6']
  },
  {
    packageId: 'hl7.terminology.r4',
    version: 'latest',
    fhirVersions: ['R4', 'R4B']
  },
  {
    packageId: 'hl7.terminology.r5',
    version: 'latest',
    fhirVersions: ['R5', 'R6']
  },
  {
    packageId: 'hl7.fhir.uv.extensions.r4',
    version: 'latest',
    fhirVersions: ['R4', 'R4B']
  },
  {
    packageId: 'hl7.fhir.uv.extensions.r5',
    version: 'latest',
    fhirVersions: ['R5', 'R6']
  }
];

export function isSupportedFHIRVersion(version: string): boolean {
  // For now, allow current or any 4.x/5.x/6.x version of FHIR except 4.0.0. This is a quick check; not a guarantee.  If a user passes
  // in an invalid version that passes this test (e.g., 4.99.0), it is still expected to fail when we load dependencies.
  return version !== '4.0.0' && /^(current|[456]\.\d+.\d+(-.+)?)$/.test(version);
}

export function ensureInputDir(input: string): string {
  // If no input folder is specified, set default to current directory
  if (!input) {
    input = '.';
    logger.info('path-to-fsh-defs defaulted to current working directory');
  }
  return input;
}

export function hasFshFiles(path: string): boolean {
  try {
    fs.statSync(path);
    const files = getFilesRecursive(path).filter(file => file.endsWith('.fsh'));
    return files.length > 0;
  } catch {
    return false;
  }
}

export function findInputDir(input: string): string {
  const originalInput = input;

  const inputFshSubdirectoryPath = path.join(originalInput, 'input', 'fsh');
  const fshSubdirectoryPath = path.join(originalInput, 'fsh');
  const rootIgDataPath = path.join(originalInput, 'ig-data');
  const currentTankWithNoFsh =
    !fs.existsSync(inputFshSubdirectoryPath) &&
    !fs.existsSync(fshSubdirectoryPath) &&
    !fs.existsSync(rootIgDataPath) &&
    !hasFshFiles(originalInput);

  // Use input/fsh/ subdirectory if not already specified and present
  // or when in the current tank configuration without FSH files
  if (fs.existsSync(inputFshSubdirectoryPath) || currentTankWithNoFsh) {
    input = path.join(originalInput, 'input', 'fsh');
  }

  // TODO: Error about unsupported features. Remove when message no longer needed.
  // Use fsh/ subdirectory if not already specified and present
  if (!fs.existsSync(inputFshSubdirectoryPath) && !currentTankWithNoFsh) {
    let msg =
      '\n\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! IMPORTANT !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n';
    if (fs.existsSync(fshSubdirectoryPath)) {
      msg +=
        '\nSUSHI detected a "fsh" directory that will be used in the input path.\n' +
        'Use of this folder is NO LONGER SUPPORTED.\n' +
        'To migrate to the new folder structure, make the following changes:\n' +
        `  - move fsh${path.sep}config.yaml to .${path.sep}sushi-config.yaml\n` +
        `  - move fsh${path.sep}*.fsh files to .${path.sep}input${path.sep}fsh${path.sep}*.fsh\n`;
      if (fs.existsSync(path.join(input, 'fsh', 'ig-data'))) {
        msg += `  - move fsh${path.sep}ig-data${path.sep}* files and folders to .${path.sep}*\n`;
      }
    } else {
      msg +=
        '\nSUSHI has adopted a new folder structure for FSH tanks (a.k.a. SUSHI projects).\n' +
        'Support for other folder structures is NO LONGER SUPPORTED.\n' +
        'To migrate to the new folder structure, make the following changes:\n' +
        `  - rename .${path.sep}config.yaml to .${path.sep}sushi-config.yaml\n` +
        `  - move .${path.sep}*.fsh files to .${path.sep}input${path.sep}fsh${path.sep}*.fsh\n`;
      if (fs.existsSync(path.join(input, 'ig-data'))) {
        msg += `  - move .${path.sep}ig-data${path.sep}* files and folders to .${path.sep}*\n`;
      }
    }
    if (!fs.existsSync(path.join(input, 'ig-data', 'ig.ini'))) {
      msg += `  - if you used the "template" property in your config, remove it and manage .${path.sep}ig.ini directly\n`;
    }
    if (!fs.existsSync(path.join(input, 'ig-data', 'package-list.json'))) {
      msg += `  - if you used the "history" property in your config, remove it and manage .${path.sep}package-list.json directly\n`;
    }
    msg +=
      '  - ensure your .gitignore file is not configured to ignore the sources in their new locations\n' +
      '  - add /fsh-generated to your .gitignore file to prevent SUSHI output from being checked into source control\n\n' +
      `NOTE: After you make these changes, the default output folder for SUSHI will change to .${path.sep}fsh-generated.\n\n` +
      'For detailed migration instructions, see: https://fshschool.org/docs/sushi/migration/\n\n';
    logger.error(msg);
  }
  return input;
}

export function ensureOutputDir(input: string, output: string): string {
  let outDir = output;
  if (!output) {
    // Default output is the parent folder of the input/fsh folder
    outDir = path.join(input, '..', '..');
    logger.info(`No output path specified. Output to ${outDir}`);
  }
  fs.ensureDirSync(outDir);
  // If the outDir contains a fsh-generated folder, we ensure that folder is empty
  const fshGeneratedFolder = path.join(outDir, 'fsh-generated');
  if (fs.existsSync(fshGeneratedFolder)) {
    try {
      fs.emptyDirSync(fshGeneratedFolder);
    } catch (e) {
      logger.error(
        `Unable to empty existing fsh-generated folder because of the following error: ${e.message}`
      );
      if (e.stack) {
        logger.debug(e.stack);
      }
    }
  }
  return outDir;
}

export function readConfig(input: string): Configuration {
  const configPath = ensureConfiguration(input);
  let config: Configuration;
  if (configPath == null || !fs.existsSync(configPath)) {
    config = loadConfigurationFromIgResource(input);
  } else {
    const configYaml = fs.readFileSync(configPath, 'utf8');
    config = importConfiguration(configYaml, configPath);
  }
  if (!config) {
    logger.error(
      `No sushi-config.yaml in ${input} folder, and no configuration could` +
        ' be extracted from an ImplementationGuide resource.'
    );
    throw Error;
  }
  if (!config.fhirVersion.some(v => isSupportedFHIRVersion(v))) {
    logger.error(
      `The ${path.basename(config.filePath)} must specify a supported version of FHIR. Be sure to` +
        ` add "fhirVersion: 4.0.1" (or 4.x.y, 5.0.0-snapshot1, etc., as appropriate) to the ${path.basename(
          config.filePath
        )} file.`
    );
    throw Error;
  }
  return config;
}

export function updateConfig(config: Configuration, program: OptionValues): void {
  if (program.config) {
    if (program.config.version) {
      config.version = program.config.version;
    }
    if (program.config.status) {
      config.status = program.config.status;
    }
    if (program.config.releaselabel) {
      const labelIndex = config.parameters.findIndex(p => p.code === 'releaselabel');
      if (labelIndex !== -1) {
        config.parameters[labelIndex].value = program.config.releaselabel;
      } else {
        config.parameters.push({
          code: 'releaselabel',
          value: program.config.releaselabel
        });
      }
    }
  }
}

export async function updateExternalDependencies(
  config: Configuration,
  registryClient: RegistryClient
): Promise<boolean> {
  // only try to update if we got the config from sushi-config.yaml, and not from an IG
  const changedVersions: Map<string, string> = new Map();
  if (config.filePath == null) {
    logger.info('Cannot update dependencies: no sushi-config.yaml file available.');
    return true;
  }
  if (!config.dependencies?.length) {
    logger.info('Cannot update dependencies: no dependencies present in configuration.');
    return true;
  }
  const promises = config.dependencies.map(async dep => {
    // current and dev have special meanings, so don't try to update those dependencies
    if (dep.version != 'current' && dep.version != 'dev') {
      try {
        const latestVersion = await registryClient.resolveVersion(dep.packageId, 'latest');
        if (dep.version !== latestVersion) {
          dep.version = latestVersion;
          changedVersions.set(dep.packageId, dep.version);
        }
      } catch {
        logger.warn(`Could not determine latest version for package ${dep.packageId}`);
      }
    }
  });
  await Promise.all(promises);
  if (changedVersions.size > 0) {
    // before changing the file, check with the user
    const continuationChoice = readlineSync.keyInYNStrict(
      [
        'Updates to dependency versions detected:',
        ...Array.from(changedVersions.entries()).map(
          ([packageId, version]) => `- ${packageId}: ${version}`
        ),
        'SUSHI can apply these updates to your sushi-config.yaml file.',
        'This may affect the formatting of your file.',
        'Do you want to apply these updates?',
        '- [Y]es, apply updates to sushi-config.yaml',
        '- [N]o, quit without applying updates',
        'Choose one: '
      ].join('\n')
    );
    if (continuationChoice === true) {
      const configText = fs.readFileSync(config.filePath, 'utf8');
      const configTree = YAML.parseDocument(configText);
      if (configTree.errors.length === 0) {
        const dependencyMap = configTree.get('dependencies');
        if (dependencyMap instanceof YAMLMap) {
          dependencyMap.items.forEach(depPair => {
            const configDep = config.dependencies.find(cd => cd.packageId === depPair.key.value);
            if (configDep) {
              if (depPair.value instanceof Collection) {
                depPair.value.set('version', configDep.version);
              } else {
                depPair.value.value = configDep.version;
              }
            }
          });
          fs.writeFileSync(config.filePath, configTree.toString(), 'utf8');
          logger.info('Updated dependency versions in configuration to latest available versions.');
        }
      }
    } else {
      logger.info('Dependencies not updated.');
      return false;
    }
  } else {
    logger.info('No dependency updates available.');
  }
  return true;
}

export async function loadExternalDependencies(
  defs: FHIRDefinitions,
  config: Configuration
): Promise<void> {
  // Add FHIR to the dependencies so it is loaded
  const dependencies = (config.dependencies ?? []).slice(); // slice so we don't modify actual config;
  const fhirVersionInfo = config.fhirVersion
    .map(v => getFHIRVersionInfo(v))
    .find(v => v.isSupported);
  if (fhirVersionInfo.isPreRelease) {
    logger.warn(
      'SUSHI support for pre-release versions of FHIR is experimental. Use at your own risk!'
    );
  }
  dependencies.push({ packageId: fhirVersionInfo.packageId, version: fhirVersionInfo.version });

  // Load automatic dependencies first so they have lowest priority in resolution
  await loadAutomaticDependencies(fhirVersionInfo.version, dependencies, defs);

  // Then load configured dependencies, with FHIR core last so it has highest priority in resolution
  await loadConfiguredDependencies(dependencies, fhirVersionInfo.version, config.filePath, defs);
}

export async function loadAutomaticDependencies(
  fhirVersion: string,
  configuredDependencies: ImplementationGuideDependsOn[],
  defs: FHIRDefinitions
): Promise<void> {
  const fhirVersionName = getFHIRVersionInfo(fhirVersion).name;

  if (fhirVersionName === 'R4' || fhirVersionName === 'R4B') {
    // There are several R5 resources that are allowed for use in R4 and R4B.
    // Add them first so they're always available.
    const R5forR4Map = new Map<string, any>();
    R5_DEFINITIONS_NEEDED_IN_R4.forEach(def => R5forR4Map.set(def.id, def));
    const virtualR5forR4Package = new InMemoryVirtualPackage(
      { name: 'sushi-r5forR4', version: '1.0.0' },
      R5forR4Map,
      {
        log: (level: string, message: string) => {
          logMessage(level, message);
        }
      }
    );
    await defs.loadVirtualPackage(virtualR5forR4Package);
  }

  // Load dependencies serially so dependency loading order is predictable and repeatable
  for (const dep of AUTOMATIC_DEPENDENCIES) {
    // Skip dependencies not intended for this version of FHIR
    if (dep.fhirVersions && !dep.fhirVersions.includes(fhirVersionName)) {
      continue;
    }
    const alreadyConfigured = configuredDependencies.some(cd => {
      // hl7.some.package, hl7.some.package.r4, and hl7.some.package.r5 all represent the same content,
      // so they are essentially interchangeable and we should allow for any of them in the config.
      // See: https://chat.fhir.org/#narrow/stream/179239-tooling/topic/New.20Implicit.20Package/near/325488084
      const [configRootId, packageRootId] = [cd.packageId, dep.packageId].map(id =>
        /\.r[4-9]$/.test(id) ? id.slice(0, -3) : id
      );
      return configRootId === packageRootId;
    });
    if (!alreadyConfigured) {
      let status: string;
      try {
        // Suppress error logs when loading automatic dependencies because many IGs can succeed without them
        defs.setFHIRPackageLoaderLogInterceptor((level: string) => {
          return level !== 'error';
        });
        status = await defs.loadPackage(dep.packageId, dep.version);
      } catch (e) {
        // This shouldn't happen, but just in case
        status = 'FAILED';
        if (e.stack) {
          logger.debug(e.stack);
        }
      } finally {
        // Unset the log interceptor so it behaves normally after this
        defs.setFHIRPackageLoaderLogInterceptor();
      }
      if (status !== 'LOADED') {
        let message = `Failed to load automatically-provided ${dep.packageId}#${dep.version}`;
        if (process.env.FPL_REGISTRY) {
          message += ` from custom FHIR package registry ${process.env.FPL_REGISTRY}.`;
        }
        logger.warn(message);
      }
    }
  }
}

async function loadConfiguredDependencies(
  dependencies: ImplementationGuideDependsOn[],
  fhirVersion: string,
  configPath: string,
  defs: FHIRDefinitions
): Promise<void> {
  // Load dependencies serially so dependency loading order is predictable and repeatable
  for (const dep of dependencies) {
    if (dep.version == null) {
      logger.error(
        `Failed to load ${dep.packageId}: No version specified. To specify the version in your ` +
          `${path.basename(configPath)}, either use the simple dependency format:\n\n` +
          'dependencies:\n' +
          `  ${dep.packageId}: current\n\n` +
          'or use the detailed dependency format to specify other properties as well:\n\n' +
          'dependencies:\n' +
          `  ${dep.packageId}:\n` +
          `    uri: ${dep.uri ?? 'http://my-fhir-ig.org/ImplementationGuide/123'}\n` +
          '    version: current'
      );
      continue;
    } else if (EXT_PKG_TO_FHIR_PKG_MAP[dep.packageId]) {
      // It is a special "virtual" FHIR extensions package indicating we need to load supplemental
      // FHIR versions to support "implied extensions".
      if (dep.version !== fhirVersion) {
        logger.warn(
          `Incorrect package version: ${dep.packageId}#${dep.version}. FHIR extensions packages ` +
            "should use the same version as the implementation guide's fhirVersion. Version " +
            `${fhirVersion} will be used instead. Update the dependency version in ` +
            'sushi-config.yaml to eliminate this warning.'
        );
      }
      logger.info(
        `Loading supplemental version of FHIR to support extensions from ${dep.packageId}`
      );
      await defs.loadSupplementalFHIRPackage(EXT_PKG_TO_FHIR_PKG_MAP[dep.packageId]);
    } else {
      await defs.loadPackage(dep.packageId, dep.version).catch(e => {
        logger.error(`Failed to load ${dep.packageId}#${dep.version}: ${e.message}`);
        if (e.stack) {
          logger.debug(e.stack);
        }
      });
    }
  }
}

export function getRawFSHes(input: string): RawFSH[] {
  let files: string[];
  try {
    fs.statSync(input);
    files = getFilesRecursive(input);
  } catch {
    logger.error('Invalid path to FSH definition folder.');
    throw Error;
  }
  const rawFSHes = files
    .filter(file => file.endsWith('.fsh'))
    .map(file => {
      const filePath = path.resolve(file);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      return new RawFSH(fileContent, filePath);
    });
  return rawFSHes;
}

export function fillTank(rawFSHes: RawFSH[], config: Configuration): FSHTank {
  logger.info('Importing FSH text...');
  const docs = importText(rawFSHes);
  return new FSHTank(docs, config);
}

export function checkNullValuesOnArray(resource: any, parentName = '', priorPath = ''): void {
  const resourceName = parentName ? parentName : (resource.id ?? resource.name);
  for (const propertyKey in resource) {
    const property = resource[propertyKey];
    const currentPath = !priorPath ? propertyKey : priorPath.concat(`.${propertyKey}`);
    // If a property's key begins with "_", we'll want to ignore null values on it's top level
    // but still check any nested objects for null values
    if (propertyKey.startsWith('_')) {
      if (isPlainObject(property)) {
        // If we encounter an object property, we'll want to check its properties as well
        checkNullValuesOnArray(property, resourceName, currentPath);
      }
      if (Array.isArray(property)) {
        property.forEach((element: any, index: number) => {
          if (isPlainObject(element)) {
            // If we encounter an object property, we'll want to check its properties as well
            checkNullValuesOnArray(element, resourceName, `${currentPath}[${index}]`);
          }
        });
      }
    } else {
      if (isPlainObject(property)) {
        // If we encounter an object property, we'll want to check its properties as well
        checkNullValuesOnArray(property, resourceName, currentPath);
      }
      if (Array.isArray(property)) {
        const nullIndexes: number[] = [];
        const hasUnderscoreArray = Array.isArray(resource[`_${propertyKey}`]);
        property.forEach((element: any, index: number) => {
          // if property is a primitive array, also check the corresponding index in the underscore property
          if (
            element === null &&
            (!hasUnderscoreArray || resource[`_${propertyKey}`][index] == null)
          ) {
            nullIndexes.push(index);
          }
          if (isPlainObject(element)) {
            // If we encounter an object property, we'll want to check its properties as well
            checkNullValuesOnArray(element, resourceName, `${currentPath}[${index}]`);
          }
        });
        if (nullIndexes.length > 0) {
          logger.warn(
            `The array '${currentPath}' in ${resourceName} is missing values at the following indices: ${nullIndexes}`
          );
        }
      }
    }
  }
}

export function writeFHIRResources(
  outDir: string,
  outPackage: Package,
  defs: FHIRDefinitions,
  snapshot: boolean
) {
  logger.info('Exporting FHIR resources as JSON...');
  let count = 0;
  const skippedResources: string[] = [];
  const predefinedResources = defs.allPredefinedResources();
  const writeResources = (
    resources: {
      getFileName: () => string;
      toJSON: (snapshot: boolean) => any;
      url?: string;
      id?: string;
      resourceType?: string;
    }[]
  ) => {
    const exportDir = path.join(outDir, 'fsh-generated', 'resources');
    resources.forEach(resource => {
      if (
        !predefinedResources.find(
          predef =>
            predef.url === resource.url &&
            predef.resourceType === resource.resourceType &&
            predef.id === resource.id
        )
      ) {
        checkNullValuesOnArray(resource);
        fs.outputJSONSync(path.join(exportDir, resource.getFileName()), resource.toJSON(snapshot), {
          spaces: 2
        });
        count++;
      } else {
        logger.error(
          `Ignoring FSH definition for ${
            resource.url ?? `${resource.resourceType}/${resource.id}`
          } since it duplicates existing pre-defined resource. ` +
            'To use the FSH definition, remove the conflicting file from "input". ' +
            'If you do want the FSH definition to be ignored, please comment the definition out ' +
            'to remove this error.'
        );
        skippedResources.push(resource.getFileName());
      }
    });
  };
  writeResources(outPackage.profiles);
  writeResources(outPackage.extensions);
  writeResources(outPackage.logicals);
  // WARNING: While custom resources are written to disk, the IG Publisher does not
  //          accept newly defined resources. However, it is configured to automatically
  //          search the fsh-generated directory for StructureDefinitions rather than using
  //          the StructureDefinitions defined in the exported implementation guide. So, be
  //          aware that the IG Publisher will attempt to process custom resources.
  //          NOTE: To mitigate against this, the parameter 'autoload-resources = false' is
  //          injected automatically into the IG array pf parameters if the parameter was
  //          not already defined and only if the custom resources were generated by Sushi.
  writeResources(outPackage.resources);
  writeResources([...outPackage.valueSets, ...outPackage.codeSystems]);

  // Filter out inline instances
  writeResources(outPackage.instances.filter(i => i._instanceMeta.usage !== 'Inline'));

  logger.info(`Exported ${count} FHIR resources as JSON.`);
  return { skippedResources };
}

export function writeFSHIndex(
  outDir: string,
  outPackage: Package,
  inputDir: string,
  skippedResources: string[] = []
) {
  const textIndex: string[][] = [];
  const jsonIndex: FshFhirMapping[] = [];
  [...outPackage.fshMap.keys()]
    .filter(fileName => !skippedResources.includes(fileName))
    .sort()
    .forEach(fileName => {
      const fshInfo = outPackage.fshMap.get(fileName);
      const relativeInput = path.relative(inputDir, fshInfo.file);
      textIndex.push([
        fileName,
        fshInfo.fshName,
        fshInfo.fshType,
        relativeInput,
        `${fshInfo.location.startLine} - ${fshInfo.location.endLine}`
      ]);
      jsonIndex.push({
        outputFile: fileName,
        fshName: fshInfo.fshName,
        fshType: fshInfo.fshType,
        fshFile: relativeInput,
        startLine: fshInfo.location.startLine,
        endLine: fshInfo.location.endLine
      });
    });
  // write txt with nice formatting
  textIndex.unshift(['Output File', 'Name', 'Type', 'FSH File', 'Lines']);
  fs.outputFileSync(path.join(outDir, 'fsh-generated', 'fsh-index.txt'), table(textIndex));
  // write json for machine usage. Use the fsh-generated/data folder for the template to pick it up. Ensure the folder exists
  fs.ensureDirSync(path.join(outDir, 'fsh-generated', 'data'));
  fs.outputJsonSync(path.join(outDir, 'fsh-generated', 'data', 'fsh-index.json'), jsonIndex, { spaces: 2 });
}

export function writePreprocessedFSH(outDir: string, inDir: string, tank: FSHTank) {
  const preprocessedPath = path.join(outDir, '_preprocessed');
  fs.ensureDirSync(preprocessedPath);
  // Because this is the FSH that exists after processing, some entities from the original FSH are gone.
  // Specifically, RuleSets have already been applied.
  // Aliases have already been resolved for most cases, but since they may still
  // be used in a slice name, they are included.
  tank.docs.forEach(doc => {
    let fileContent = '';
    // First, get all Aliases. They don't have source information.
    if (doc.aliases.size > 0) {
      doc.aliases.forEach((url, alias) => {
        fileContent += `Alias: ${alias} = ${url}${EOL}`;
      });
      fileContent += EOL;
    }
    // Then, get all other applicable entities. They will have source information.
    const entities = [
      ...doc.profiles.values(),
      ...doc.extensions.values(),
      ...doc.logicals.values(),
      ...doc.resources.values(),
      ...doc.instances.values(),
      ...doc.valueSets.values(),
      ...doc.codeSystems.values(),
      ...doc.invariants.values(),
      ...doc.mappings.values()
    ];
    // Sort entities by original line number, then write them out.
    sortBy(entities, 'sourceInfo.location.startLine').forEach(entity => {
      fileContent += `// Originally defined on lines ${entity.sourceInfo.location.startLine} - ${entity.sourceInfo.location.endLine}${EOL}`;
      fileContent += `${entity.toFSH()}${EOL}${EOL}`;
    });
    if (fileContent.length === 0) {
      fileContent = '// This file has no content after preprocessing.';
    }
    const outPath = path.relative(inDir, doc.file);
    fs.ensureFileSync(path.join(preprocessedPath, outPath));
    fs.writeFileSync(path.join(preprocessedPath, outPath), fileContent);
  });
  logger.info(`Wrote preprocessed FSH to ${preprocessedPath}`);
}

/**
 * Initializes an empty sample FSH within a user specified subdirectory of the current working directory
 */
export async function init(
  name: string = null,
  options: { config?: OptionValues; default?: boolean; autoInitialize?: boolean } = {}
): Promise<void> {
  console.log(
    '\n╭───────────────────────────────────────────────────────────╮\n' +
      '│ This interactive tool will use your answers to create a   │\n' +
      "│ working SUSHI project configured with your project's      │\n" +
      '│ basic information. Any answers provided as command line   │\n' +
      '│ options will be used automatically.                       │\n' +
      '╰───────────────────────────────────────────────────────────╯\n'
  );

  const configDoc = YAML.parseDocument(
    fs.readFileSync(path.join(__dirname, 'init-project', 'sushi-config.yaml'), 'utf-8')
  );
  // Accept user input for certain fields directly or from CLI options
  ['name', 'id', 'canonical', 'status', 'version', 'releaseLabel'].forEach(field => {
    let userValue: string;
    if (options.config?.[field.toLowerCase()] != null) {
      userValue = options.config[field.toLowerCase()];
      console.log(`${startCase(field)}: ${options.config[field.toLowerCase()]}`);
    } else if (field === 'name' && name != null) {
      // name is an argument on the CLI (not an option) so handle it separately
      userValue = name;
      console.log(`Name: ${name}`);
    } else if (options.default) {
      console.log(`${startCase(field)}: ${configDoc.get(field)}`);
    } else {
      userValue = readlineSync.question(`${startCase(field)} (Default: ${configDoc.get(field)}): `);
    }
    if (userValue) {
      if (field === 'status') {
        const node = YAML.createNode(userValue);
        node.comment = ' draft | active | retired | unknown';
        configDoc.set(field, node);
      } else {
        configDoc.set(field, userValue);
      }
    }
  });

  // And for nested publisher fields
  ['name', 'url'].forEach(field => {
    let userValue: string;
    if (options.config?.[`publisher-${field}`] != null) {
      userValue = options.config[`publisher-${field}`];
      console.log(`Publisher ${upperFirst(field)}: ${options.config[`publisher-${field}`]}`);
    } else if (options.default) {
      console.log(`Publisher ${upperFirst(field)}: ${configDoc.get('publisher').get(field)}`);
    } else {
      userValue = readlineSync.question(
        `Publisher ${upperFirst(field)} (Default: ${configDoc.get('publisher').get(field)}): `
      );
    }
    if (userValue) {
      configDoc.get('publisher').set(field, userValue);
    }
  });

  // Ensure copyrightYear is accurate
  configDoc.set('copyrightYear', `${new Date().getFullYear()}+`);
  const projectName = configDoc.get('name');

  // Write init directory out, including user made sushi-config.yaml and files in utils/init-project
  const outputDir = path.resolve('.', projectName);
  const initProjectDir = path.join(__dirname, 'init-project');
  if (options.autoInitialize) {
    console.log(`Initializing SUSHI project in ${outputDir}`);
  } else if (!readlineSync.keyInYN(`Initialize SUSHI project in ${outputDir}?`)) {
    console.log('\nAborting Initialization.\n');
    return;
  }

  // Add index.md content, updating to reflect the user given name
  const indexPageContent = fs
    .readFileSync(path.join(initProjectDir, 'index.md'), 'utf-8')
    .replace('ExampleIG', projectName);
  fs.ensureDirSync(path.join(outputDir, 'input', 'pagecontent'));
  fs.writeFileSync(path.join(outputDir, 'input', 'pagecontent', 'index.md'), indexPageContent);
  // Add ig.ini, updating to reflect the user given id
  const iniContent = fs
    .readFileSync(path.join(initProjectDir, 'ig.ini'), 'utf-8')
    .replace('fhir.example', configDoc.get('id'));
  fs.writeFileSync(path.join(outputDir, 'ig.ini'), iniContent);
  // Add the config
  fs.writeFileSync(path.join(outputDir, 'sushi-config.yaml'), configDoc.toString());
  // Copy over remaining static files
  fs.ensureDirSync(path.join(outputDir, 'input', 'fsh'));
  fs.copyFileSync(
    path.join(initProjectDir, 'patient.fsh'),
    path.join(outputDir, 'input', 'fsh', 'patient.fsh')
  );
  fs.copyFileSync(
    path.join(initProjectDir, 'init-gitignore.txt'),
    path.join(outputDir, '.gitignore')
  );
  fs.copyFileSync(
    path.join(initProjectDir, 'ignoreWarnings.txt'),
    path.join(outputDir, 'input', 'ignoreWarnings.txt')
  );
  // Add the _updatePublisher, _genonce, and _gencontinuous scripts
  console.log('Downloading publisher scripts from https://github.com/HL7/ig-publisher-scripts');
  for (const script of [
    '_genonce.bat',
    '_genonce.sh',
    '_updatePublisher.bat',
    '_updatePublisher.sh'
  ]) {
    const url = `https://raw.githubusercontent.com/HL7/ig-publisher-scripts/main/${script}`;
    try {
      const res = await axiosGet(url);
      fs.writeFileSync(path.join(outputDir, script), res.data);
      if (script.endsWith('.sh')) {
        fs.chmodSync(path.join(outputDir, script), 0o755);
      }
    } catch (e) {
      logger.error(`Unable to download ${script} from ${url}: ${e.message}`);
      if (e.stack) {
        logger.debug(e.stack);
      }
    }
  }
  const maxLength = 32;
  const printName =
    projectName.length > maxLength ? projectName.slice(0, maxLength - 3) + '...' : projectName;
  console.log(
    '\n╭───────────────────────────────────────────────────────────╮\n' +
      `│ Project initialized at: ./${padEnd(printName, maxLength)}│\n` +
      '├───────────────────────────────────────────────────────────┤\n' +
      '│ Now try this:                                             │\n' +
      '│                                                           │\n' +
      `│ > cd ${padEnd(printName, maxLength + 21)}│\n` +
      '│ > sushi .                                                 │\n' +
      '│                                                           │\n' +
      '│ For guidance on project structure and configuration see   │\n' +
      '│ the SUSHI documentation: https://fshschool.org/docs/sushi │\n' +
      '╰───────────────────────────────────────────────────────────╯\n'
  );
}

export function getFilesRecursive(dir: string): string[] {
  // always return absolute paths
  const absPath = path.resolve(dir);
  try {
    if (fs.statSync(absPath).isDirectory()) {
      const descendants = fs
        .readdirSync(absPath, 'utf8')
        .map(f => getFilesRecursive(path.join(absPath, f)));
      return [].concat(...descendants);
    } else {
      return [absPath];
    }
  } catch {
    return [];
  }
}

export function getLocalSushiVersion(): string {
  const packageJSONPath = path.join(__dirname, '..', '..', 'package.json');
  if (fs.existsSync(packageJSONPath)) {
    return fs.readJSONSync(packageJSONPath)?.version;
  }
  return null;
}

async function getLatestSushiVersionFallback(): Promise<string> {
  logger.info('Attempting fallback to determine version of sushi.');
  try {
    const res = await axiosGet('https://registry.npmjs.org/fsh-sushi');
    const latestVer = res.data['dist-tags'].latest;
    if (latestVer.match(/^[0-9\.]*$/)) {
      return latestVer;
    } else {
      logger.warn('Unable to determine the latest version of sushi.');
    }
  } catch (e) {
    logger.warn(`Unable to determine the latest version of sushi: ${e.message}`);
    if (e.stack) {
      logger.debug(e.stack);
    }
  }
}

export async function getLatestSushiVersion(): Promise<string | undefined> {
  let latestVer: string | undefined = undefined;

  const getRegistryCmd = 'npm view fsh-sushi version';
  try {
    const execResult = execSync(getRegistryCmd)?.toString()?.replace(/\s*$/, '');
    if (execResult.match(/^[0-9\.]*$/)) {
      latestVer = execResult;
    }
  } catch (e) {
    logger.info(`Unable to determine the latest version of sushi: ${e.message}`);
    if (e.stack) {
      logger.debug(e.stack);
    }
  }

  if (latestVer === undefined) {
    latestVer = await getLatestSushiVersionFallback();
  }
  return latestVer;
}

export async function checkSushiVersion(): Promise<{
  latest: string | undefined;
  current: string;
}> {
  const latest = await getLatestSushiVersion();
  const current = getLocalSushiVersion();

  return { latest, current };
}
