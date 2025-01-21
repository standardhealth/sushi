import axios from 'axios';
import child_process from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import temp from 'temp';
import { minimalConfig } from './minimalConfig';
import { loggerSpy } from '../testhelpers/loggerSpy';
import {
  assertAutomaticR4Dependencies,
  assertAutomaticR5Dependencies
} from '../testhelpers/asserts';
import readlineSync from 'readline-sync';
import {
  isSupportedFHIRVersion,
  ensureInputDir,
  findInputDir,
  ensureOutputDir,
  readConfig,
  updateExternalDependencies,
  loadExternalDependencies,
  loadAutomaticDependencies,
  getRawFSHes,
  hasFshFiles,
  writeFHIRResources,
  init,
  checkNullValuesOnArray,
  writePreprocessedFSH,
  getLocalSushiVersion,
  getLatestSushiVersion,
  checkSushiVersion,
  writeFSHIndex,
  updateConfig
} from '../../src/utils/Processing';
import { FHIRDefinitions } from '../../src/fhirdefs';
import { Package } from '../../src/export';
import { StructureDefinition, ValueSet, CodeSystem, InstanceDefinition } from '../../src/fhirtypes';
import { cloneDeep } from 'lodash';
import { FSHTank, FSHDocument } from '../../src/import';
import {
  Profile,
  Extension,
  Instance,
  FshValueSet,
  FshCodeSystem,
  Invariant,
  RuleSet,
  Mapping,
  Logical,
  Resource,
  Configuration
} from '../../src/fshtypes';
import { EOL } from 'os';
import { PREDEFINED_PACKAGE_NAME, PREDEFINED_PACKAGE_VERSION } from '../../src/ig';
import { getTestFHIRDefinitions } from '../../test/testhelpers';
import { InMemoryVirtualPackage, RegistryClient } from 'fhir-package-loader';
import { logMessage } from '../../src/utils';
import { mock, MockProxy } from 'jest-mock-extended';

const NUM_R4_AUTO_DEPENDENCIES = 4;
const NUM_R5_AUTO_DEPENDENCIES = 3;

describe('Processing', () => {
  temp.track();

  describe('#isSupportedFHIRVersion', () => {
    it('should support published version >= 4.0.1', () => {
      expect(isSupportedFHIRVersion('4.0.1')).toBe(true);
      expect(isSupportedFHIRVersion('4.2.0')).toBe(true);
      expect(isSupportedFHIRVersion('4.4.0')).toBe(true);
      expect(isSupportedFHIRVersion('4.5.0')).toBe(true);
    });

    it('should support current version', () => {
      expect(isSupportedFHIRVersion('current')).toBe(true);
    });

    it('should not support published versions < 4.0.1', () => {
      expect(isSupportedFHIRVersion('4.0.0')).toBe(false);
      expect(isSupportedFHIRVersion('3.0.2')).toBe(false);
      expect(isSupportedFHIRVersion('1.0.2')).toBe(false);
      expect(isSupportedFHIRVersion('0.0.82')).toBe(false);
    });
  });

  describe('#findInputDir()', () => {
    let tempRoot: string;

    beforeAll(() => {
      tempRoot = temp.mkdirSync('sushi-test');
      fs.mkdirpSync(path.join(tempRoot, 'has-fsh', 'fsh')); // TODO: Tests legacy support. Remove when no longer supported.
      fs.mkdirpSync(path.join(tempRoot, 'has-input-fsh', 'input', 'fsh'));
      fs.mkdirpSync(path.join(tempRoot, 'has-input', 'input'));
      fs.mkdirpSync(path.join(tempRoot, 'has-fsh-and-input-fsh', 'fsh')); // TODO: Tests legacy support. Remove when no longer supported.
      fs.mkdirpSync(path.join(tempRoot, 'has-fsh-and-input-fsh', 'input', 'fsh'));
      fs.mkdirpSync(path.join(tempRoot, 'flat-tank', 'ig-data')); // TODO: Tests legacy support. Remove when no longer supported.
      fs.mkdirSync(path.join(tempRoot, 'no-fsh'));
      fs.ensureFileSync(path.join(tempRoot, 'no-fsh', 'notfsh.txt'));
    });

    beforeEach(() => {
      loggerSpy.reset();
    });

    afterAll(() => {
      temp.cleanupSync();
    });

    it('should find a path to the current working directory when no input folder is specified', () => {
      const foundInput = ensureInputDir(undefined);
      expect(foundInput).toBe('.');
    });

    it('should find a path to the input/fsh subdirectory if present', () => {
      const input = path.join(tempRoot, 'has-input-fsh');
      const foundInput = findInputDir(input);
      expect(foundInput).toBe(path.join(tempRoot, 'has-input-fsh', 'input', 'fsh'));
    });

    it('should use path to input/fsh as input if input/ subdirectory present but no input/fsh present', () => {
      const input = path.join(tempRoot, 'has-input');
      const foundInput = findInputDir(input);
      expect(foundInput).toBe(path.join(tempRoot, 'has-input', 'input', 'fsh'));
      expect(loggerSpy.getAllMessages()).toHaveLength(0);
    });

    it('should find a path to input/fsh if no fsh files are present, no root level ig-data folder, and no fsh subdirectory (current tank with no fsh files)', () => {
      const input = path.join(tempRoot, 'no-fsh');
      const foundInput = findInputDir(input);
      expect(foundInput).toBe(path.join(tempRoot, 'no-fsh', 'input', 'fsh'));
    });

    // TODO: Tests current tank configuration is preferred over legacy. Remove when legacy error handling is removed.
    it('should prefer path to input/fsh over fsh/ if both present', () => {
      const input = path.join(tempRoot, 'has-fsh-and-input-fsh');
      const foundInput = findInputDir(input);
      expect(foundInput).toBe(path.join(tempRoot, 'has-fsh-and-input-fsh', 'input', 'fsh'));
    });

    // TODO: Tests legacy case logs error. Remove when error is removed.
    it('should log an error and not change input directory if the fsh subdirectory if present (legacy ./fsh/)', () => {
      const input = path.join(tempRoot, 'has-fsh');
      const foundInput = findInputDir(input);
      expect(foundInput).toBe(path.join(tempRoot, 'has-fsh'));
      expect(loggerSpy.getLastMessage('error')).toMatch(
        /Use of this folder is NO LONGER SUPPORTED/s
      );
    });

    // TODO: Tests legacy case logs error. Remove when error is removed.
    it('should log an error and not change input directory if the fsh subdirectory is not present and a root ig-data is present (legacy flat tank)', () => {
      const input = path.join(tempRoot, 'flat-tank');
      const foundInput = findInputDir(input);
      expect(foundInput).toBe(input);
      expect(loggerSpy.getLastMessage('error')).toMatch(
        /Support for other folder structures is NO LONGER SUPPORTED/s
      );
    });
  });

  describe('#ensureOutputDir()', () => {
    let tempRoot: string;
    let emptyDirSpy: jest.SpyInstance;

    beforeAll(() => {
      tempRoot = temp.mkdirSync('sushi-test');
      fs.mkdirSync(path.join(tempRoot, 'my-input'));
    });

    beforeEach(() => {
      emptyDirSpy = jest.spyOn(fs, 'emptyDirSync').mockImplementation(() => '');
      emptyDirSpy.mockReset();
    });

    afterAll(() => {
      temp.cleanupSync();
    });

    it('should use and create the output directory when it is provided', () => {
      const input = path.join(tempRoot, 'my-input');
      const output = path.join(tempRoot, 'my-output');
      const outputDir = ensureOutputDir(input, output);
      expect(outputDir).toBe(output);
      expect(fs.existsSync(output)).toBeTruthy();
    });

    it('should default the output directory to the grandparent of the input no output directory provided (e.g. ./input/fsh -> ./)', () => {
      const input = path.join(tempRoot, 'my-input', 'my-fsh');
      const outputDir = ensureOutputDir(input, undefined);
      expect(outputDir).toBe(tempRoot);
      expect(fs.existsSync(outputDir)).toBeTruthy();
      expect(loggerSpy.getLastMessage('info')).toMatch(/No output path specified/);
    });

    it('should empty the fsh-generated folder if the output directory contains one', () => {
      jest
        .spyOn(fs, 'existsSync')
        .mockImplementationOnce(dir => dir === path.join(tempRoot, 'fsh-generated'));
      const input = path.join(tempRoot, 'my-input', 'my-fsh');
      const outputDir = ensureOutputDir(input, undefined);
      expect(outputDir).toBe(tempRoot);
      expect(fs.existsSync(outputDir)).toBeTruthy();
      expect(emptyDirSpy.mock.calls).toHaveLength(1);
      expect(emptyDirSpy.mock.calls[0][0]).toBe(path.join(tempRoot, 'fsh-generated'));
    });

    it('should log an error when emptying the directory fails', () => {
      emptyDirSpy = emptyDirSpy.mockImplementation(() => {
        throw Error('foo');
      });
      jest
        .spyOn(fs, 'existsSync')
        .mockImplementationOnce(dir => dir === path.join(tempRoot, 'fsh-generated'));
      const input = path.join(tempRoot, 'my-input', 'my-fsh');
      const outputDir = ensureOutputDir(input, undefined);
      expect(outputDir).toBe(tempRoot);
      expect(fs.existsSync(outputDir)).toBeTruthy();
      expect(emptyDirSpy.mock.calls).toHaveLength(1);
      expect(emptyDirSpy.mock.calls[0][0]).toBe(path.join(tempRoot, 'fsh-generated'));
      expect(loggerSpy.getLastMessage('error')).toMatch(
        /Unable to empty existing fsh-generated folder.*: foo/
      );
    });
  });

  describe('#readConfig()', () => {
    beforeEach(() => {
      loggerSpy.reset();
    });

    it('should return the contents of sushi-config.yaml from the input directory', () => {
      const input = path.join(__dirname, 'fixtures', 'valid-yaml');
      const config = readConfig(input);
      expect(config).toEqual({
        filePath: path.join(__dirname, 'fixtures', 'valid-yaml', 'sushi-config.yaml'),
        id: 'sushi-test',
        packageId: 'sushi-test',
        canonical: 'http://hl7.org/fhir/sushi-test',
        url: 'http://hl7.org/fhir/sushi-test/ImplementationGuide/sushi-test',
        version: '0.1.0',
        name: 'FSHTestIG',
        title: 'FSH Test IG',
        status: 'active',
        contact: [
          {
            name: 'Bill Cod',
            telecom: [
              { system: 'url', value: 'https://capecodfishermen.org/' },
              { system: 'email', value: 'cod@reef.gov' }
            ]
          }
        ],
        description: 'Provides a simple example of how FSH can be used to create an IG',
        license: 'CC0-1.0',
        fhirVersion: ['4.0.1'],
        dependencies: [
          { packageId: 'hl7.fhir.us.core', version: '3.1.0' },
          { packageId: 'hl7.fhir.uv.vhdir', version: 'current' }
        ],
        FSHOnly: false,
        applyExtensionMetadataToRoot: true,
        instanceOptions: { setMetaProfile: 'always', setId: 'always', manualSliceOrdering: false },
        parameters: [
          {
            code: 'copyrightyear',
            value: '2020'
          },
          {
            code: 'releaselabel',
            value: 'CI Build'
          }
        ]
      });
    });

    it('should allow FHIR R5', () => {
      const input = path.join(__dirname, 'fixtures', 'fhir-r5');
      const config = readConfig(input);
      expect(config.fhirVersion).toEqual(['4.5.0']);
    });

    it('should allow FHIR R6 prerelease', () => {
      const input = path.join(__dirname, 'fixtures', 'fhir-r6-prerelease');
      const config = readConfig(input);
      expect(config.fhirVersion).toEqual(['6.0.0-ballot2']);
    });

    it('should allow FHIR R6 full release', () => {
      const input = path.join(__dirname, 'fixtures', 'fhir-r6');
      const config = readConfig(input);
      expect(config.fhirVersion).toEqual(['6.0.0']);
    });

    it('should allow FHIR current', () => {
      const input = path.join(__dirname, 'fixtures', 'fhir-current');
      const config = readConfig(input);
      expect(config.fhirVersion).toEqual(['current']);
    });

    it('should extract a configuration from an ImplementationGuide JSON when sushi-config.yaml is absent', () => {
      const input = path.join(__dirname, 'fixtures', 'ig-JSON-only');
      const config = readConfig(input);
      expect(config).toEqual({
        FSHOnly: true,
        canonical: 'http://example.org',
        dependencies: undefined,
        fhirVersion: ['4.0.1'],
        name: undefined,
        packageId: undefined,
        status: 'draft',
        parameters: [],
        url: 'http://example.org',
        version: undefined
      });
    });

    it('should log and throw an error when sushi-config.yaml is not found in the input directory', () => {
      const input = path.join(__dirname, 'fixtures', 'no-package');
      expect(() => {
        readConfig(input);
      }).toThrow();
      expect(loggerSpy.getLastMessage('error')).toMatch(/No sushi-config\.yaml/s);
    });

    it('should log and throw an error when the contents of sushi-config.yaml are not valid yaml', () => {
      const input = path.join(__dirname, 'fixtures', 'invalid-yaml');
      expect(() => {
        readConfig(input);
      }).toThrow();
      expect(loggerSpy.getLastMessage('error')).toMatch(/not a valid YAML object/s);
    });

    it('should log and throw an error when the configuration uses an unsupported FHIR version (DSTU2)', () => {
      const input = path.join(__dirname, 'fixtures', 'fhir-dstu2');
      expect(() => {
        readConfig(input);
      }).toThrow();
      expect(loggerSpy.getLastMessage('error')).toMatch(
        /must specify a supported version of FHIR/s
      );
    });

    it('should log and throw an error when the configuration uses an unsupported FHIR version (4.0.0)', () => {
      const input = path.join(__dirname, 'fixtures', 'fhir-four-oh-oh');
      expect(() => {
        readConfig(input);
      }).toThrow();
      expect(loggerSpy.getLastMessage('error')).toMatch(
        /must specify a supported version of FHIR/s
      );
    });
  });

  describe('#updateConfig', () => {
    it('should update the config with the command line options', () => {
      const input = path.join(__dirname, 'fixtures', 'valid-yaml');
      const config = readConfig(input);
      updateConfig(config, {
        config: { version: '1.2.3', status: 'draft', releaselabel: 'qa-preview' }
      });

      expect(config).toEqual({
        filePath: path.join(__dirname, 'fixtures', 'valid-yaml', 'sushi-config.yaml'),
        id: 'sushi-test',
        packageId: 'sushi-test',
        canonical: 'http://hl7.org/fhir/sushi-test',
        url: 'http://hl7.org/fhir/sushi-test/ImplementationGuide/sushi-test',
        version: '1.2.3',
        name: 'FSHTestIG',
        title: 'FSH Test IG',
        status: 'draft',
        contact: [
          {
            name: 'Bill Cod',
            telecom: [
              { system: 'url', value: 'https://capecodfishermen.org/' },
              { system: 'email', value: 'cod@reef.gov' }
            ]
          }
        ],
        description: 'Provides a simple example of how FSH can be used to create an IG',
        license: 'CC0-1.0',
        fhirVersion: ['4.0.1'],
        dependencies: [
          { packageId: 'hl7.fhir.us.core', version: '3.1.0' },
          { packageId: 'hl7.fhir.uv.vhdir', version: 'current' }
        ],
        FSHOnly: false,
        applyExtensionMetadataToRoot: true,
        instanceOptions: { setMetaProfile: 'always', setId: 'always', manualSliceOrdering: false },
        parameters: [
          {
            code: 'copyrightyear',
            value: '2020'
          },
          {
            code: 'releaselabel',
            value: 'qa-preview'
          }
        ]
      });
    });

    it('should ignore unsupported elements', () => {
      const input = path.join(__dirname, 'fixtures', 'valid-yaml');
      const config = readConfig(input);
      updateConfig(config, {
        config: { version: '1.2.3', something: 'unsupported' }
      });

      expect(config).toEqual({
        filePath: path.join(__dirname, 'fixtures', 'valid-yaml', 'sushi-config.yaml'),
        id: 'sushi-test',
        packageId: 'sushi-test',
        canonical: 'http://hl7.org/fhir/sushi-test',
        url: 'http://hl7.org/fhir/sushi-test/ImplementationGuide/sushi-test',
        version: '1.2.3',
        name: 'FSHTestIG',
        title: 'FSH Test IG',
        status: 'active',
        contact: [
          {
            name: 'Bill Cod',
            telecom: [
              { system: 'url', value: 'https://capecodfishermen.org/' },
              { system: 'email', value: 'cod@reef.gov' }
            ]
          }
        ],
        description: 'Provides a simple example of how FSH can be used to create an IG',
        license: 'CC0-1.0',
        fhirVersion: ['4.0.1'],
        dependencies: [
          { packageId: 'hl7.fhir.us.core', version: '3.1.0' },
          { packageId: 'hl7.fhir.uv.vhdir', version: 'current' }
        ],
        FSHOnly: false,
        applyExtensionMetadataToRoot: true,
        instanceOptions: { setMetaProfile: 'always', setId: 'always', manualSliceOrdering: false },
        parameters: [
          {
            code: 'copyrightyear',
            value: '2020'
          },
          {
            code: 'releaselabel',
            value: 'CI Build'
          }
        ]
      });
    });

    it('should support values with colons', () => {
      const input = path.join(__dirname, 'fixtures', 'valid-yaml');
      const config = readConfig(input);
      updateConfig(config, {
        //not a valid semver, just to make a point
        config: { version: '1.2.3-beta:1' }
      });

      expect(config).toEqual({
        filePath: path.join(__dirname, 'fixtures', 'valid-yaml', 'sushi-config.yaml'),
        id: 'sushi-test',
        packageId: 'sushi-test',
        canonical: 'http://hl7.org/fhir/sushi-test',
        url: 'http://hl7.org/fhir/sushi-test/ImplementationGuide/sushi-test',
        version: '1.2.3-beta:1',
        name: 'FSHTestIG',
        title: 'FSH Test IG',
        status: 'active',
        contact: [
          {
            name: 'Bill Cod',
            telecom: [
              { system: 'url', value: 'https://capecodfishermen.org/' },
              { system: 'email', value: 'cod@reef.gov' }
            ]
          }
        ],
        description: 'Provides a simple example of how FSH can be used to create an IG',
        license: 'CC0-1.0',
        fhirVersion: ['4.0.1'],
        dependencies: [
          { packageId: 'hl7.fhir.us.core', version: '3.1.0' },
          { packageId: 'hl7.fhir.uv.vhdir', version: 'current' }
        ],
        FSHOnly: false,
        applyExtensionMetadataToRoot: true,
        instanceOptions: { setMetaProfile: 'always', setId: 'always', manualSliceOrdering: false },
        parameters: [
          {
            code: 'copyrightyear',
            value: '2020'
          },
          {
            code: 'releaselabel',
            value: 'CI Build'
          }
        ]
      });
    });
  });

  describe('#updateExternalDependencies', () => {
    let tempRoot: string;
    let config: Configuration;
    let keyInSpy: jest.SpyInstance;
    let registryClientMock: MockProxy<RegistryClient>;

    beforeAll(() => {
      tempRoot = temp.mkdirSync('sushi-test');
    });

    beforeEach(() => {
      registryClientMock = mock<RegistryClient>();
      registryClientMock.resolveVersion.mockImplementation((name: string, version: string) => {
        if (version !== 'latest') {
          return Promise.resolve(version);
        }
        switch (name) {
          case 'hl7.fhir.us.core':
            return Promise.resolve('3.1.0');
          case 'hl7.fhir.uv.genomics-reporting':
            return Promise.resolve('3.5.0');
          case 'hl7.fhir.us.mcode':
            return Promise.resolve('2.1.1');
          default:
            return Promise.resolve(version);
        }
      });

      const originalInput = path.join(
        __dirname,
        'fixtures',
        'extra-dependencies',
        'sushi-config.yaml'
      );
      fs.copyFileSync(originalInput, path.join(tempRoot, 'sushi-config.yaml'));
      config = readConfig(tempRoot);
      keyInSpy = jest.spyOn(readlineSync, 'keyInYNStrict');
    });

    afterEach(() => {
      keyInSpy.mockReset();
    });

    afterAll(() => {
      temp.cleanupSync();
    });

    it('should update versioned dependencies in the configuration', async () => {
      keyInSpy.mockReturnValueOnce(true);
      const result = await updateExternalDependencies(config, registryClientMock);
      expect(result).toBe(true);
      const updatedDependencies = [
        {
          packageId: 'hl7.fhir.us.core',
          version: '3.1.0'
        },
        {
          packageId: 'hl7.fhir.uv.vhdir',
          version: 'current'
        },
        {
          packageId: 'hl7.fhir.uv.genomics-reporting',
          version: '3.5.0'
        },
        {
          packageId: 'hl7.fhir.us.mcode',
          id: 'mcode',
          uri: 'http://hl7.org/fhir/us/mcode/ImplementationGuide/hl7.fhir.us.mcode',
          version: '2.1.1'
        },
        {
          packageId: 'hl7.fhir.us.davinci-pas',
          version: 'dev'
        }
      ];
      expect(config.dependencies).toEqual(updatedDependencies);
      const configOnDisk = readConfig(tempRoot);
      expect(configOnDisk.dependencies).toEqual(updatedDependencies);
    });

    it('should display a list of the available version updates', async () => {
      keyInSpy.mockReturnValueOnce(true);
      const result = await updateExternalDependencies(config, registryClientMock);
      expect(result).toBe(true);
      const displayedMessage = keyInSpy.mock.calls[0][0] as string;
      expect(displayedMessage).toMatch('- hl7.fhir.uv.genomics-reporting: 3.5.0');
      expect(displayedMessage).toMatch('- hl7.fhir.us.mcode: 2.1.1');
      // packages without updates should not be listed
      expect(displayedMessage).not.toMatch('hl7.fhir.us.core');
      expect(displayedMessage).not.toMatch('hl7.fhir.uv.vhdir');
      expect(displayedMessage).not.toMatch('hl7.fhir.us.davinci-pas');
    });

    it('should not update dependencies if the user quits without applying updates', async () => {
      keyInSpy.mockReturnValueOnce(false);
      const result = await updateExternalDependencies(config, registryClientMock);
      expect(result).toBe(false);
      const originalDependencies = [
        {
          packageId: 'hl7.fhir.us.core',
          version: '3.1.0'
        },
        {
          packageId: 'hl7.fhir.uv.vhdir',
          version: 'current'
        },
        {
          packageId: 'hl7.fhir.uv.genomics-reporting',
          version: '2.0.0'
        },
        {
          packageId: 'hl7.fhir.us.mcode',
          id: 'mcode',
          uri: 'http://hl7.org/fhir/us/mcode/ImplementationGuide/hl7.fhir.us.mcode',
          version: '2.0.1'
        },
        {
          packageId: 'hl7.fhir.us.davinci-pas',
          version: 'dev'
        }
      ];
      const configOnDisk = readConfig(tempRoot);
      expect(configOnDisk.dependencies).toEqual(originalDependencies);
    });

    it('should return true without requiring input if no dependencies can be updated', async () => {
      config.dependencies = [
        {
          packageId: 'hl7.fhir.us.core',
          version: '3.1.0'
        },
        {
          packageId: 'hl7.fhir.uv.vhdir',
          version: 'current'
        },
        {
          packageId: 'hl7.fhir.us.davinci-pas',
          version: 'dev'
        }
      ];
      const result = await updateExternalDependencies(config, registryClientMock);
      expect(result).toBe(true);
      expect(keyInSpy).toHaveBeenCalledTimes(0);
    });

    it('should return true without requiring input if the configuration was obtained without a sushi-config.yaml file', async () => {
      delete config.filePath;
      const result = await updateExternalDependencies(config, registryClientMock);
      expect(result).toBe(true);
      expect(keyInSpy).toHaveBeenCalledTimes(0);
    });

    it('should return true without requiring input if there are no dependencies in the configuration', async () => {
      config.dependencies = [];
      const result = await updateExternalDependencies(config, registryClientMock);
      expect(result).toBe(true);
      expect(keyInSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('#loadExternalDependencies()', () => {
    beforeEach(() => {
      loggerSpy.reset();
    });

    it('should load specified dependencies', async () => {
      const usCoreDependencyConfig = cloneDeep(minimalConfig);
      usCoreDependencyConfig.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, usCoreDependencyConfig).then(async () => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(2 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r4.core#4.0.1');
        expect(loadedPackages).toContain('hl7.fhir.us.core#3.1.0');
        assertAutomaticR4Dependencies(loadedPackages);
        expect(loggerSpy.getAllLogs('warn')).toHaveLength(0);
      });
    });

    it('should load automatic dependencies first so they have lowest priority', async () => {
      const usCoreDependencyConfig = cloneDeep(minimalConfig);
      usCoreDependencyConfig.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, usCoreDependencyConfig).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(2 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toEqual([
          'sushi-r5forR4#1.0.0',
          'hl7.fhir.uv.tools.r4#9.9.9',
          'hl7.terminology.r4#9.9.9',
          'hl7.fhir.uv.extensions.r4#9.9.9',
          'hl7.fhir.us.core#3.1.0',
          'hl7.fhir.r4.core#4.0.1'
        ]);
        expect(loggerSpy.getAllLogs('warn')).toHaveLength(0);
      });
    });

    it('should honor user-specified order when user puts automatic dependencies in the config', async () => {
      const usCoreDependencyConfig = cloneDeep(minimalConfig);
      usCoreDependencyConfig.dependencies = [
        { packageId: 'hl7.fhir.us.core', version: '3.1.0' },
        { packageId: 'hl7.fhir.uv.extensions.r4', version: '7.7.7' },
        { packageId: 'hl7.terminology.r4', version: '8.8.8' },
        { packageId: 'hl7.fhir.uv.tools.r4', version: '9.8.7' }
      ];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, usCoreDependencyConfig).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(2 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toEqual([
          'sushi-r5forR4#1.0.0',
          'hl7.fhir.us.core#3.1.0',
          'hl7.fhir.uv.extensions.r4#7.7.7',
          'hl7.terminology.r4#8.8.8',
          'hl7.fhir.uv.tools.r4#9.8.7',
          'hl7.fhir.r4.core#4.0.1'
        ]);
        expect(loggerSpy.getAllLogs('warn')).toHaveLength(0);
      });
    });

    it('should support prerelease FHIR R4B dependencies', async () => {
      const config = cloneDeep(minimalConfig);
      config.fhirVersion = ['4.1.0'];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, config).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r4b.core#4.1.0');
        expect(loadedPackages).toContain('sushi-r5forR4#1.0.0');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r4#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r4#9.9.9');
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /support for pre-release versions of FHIR is experimental/s
        );
      });
    });

    it('should support prerelease FHIR R4B snapshot dependencies', async () => {
      const config = cloneDeep(minimalConfig);
      config.fhirVersion = ['4.3.0-snapshot1'];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, config).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r4b.core#4.3.0-snapshot1');
        expect(loadedPackages).toContain('sushi-r5forR4#1.0.0');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r4#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r4#9.9.9');
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /support for pre-release versions of FHIR is experimental/s
        );
      });
    });

    it('should support official FHIR R4B dependency', async () => {
      const config = cloneDeep(minimalConfig);
      config.fhirVersion = ['4.3.0'];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, config).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r4b.core#4.3.0');
        expect(loadedPackages).toContain('sushi-r5forR4#1.0.0');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r4#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r4#9.9.9');
        expect(loggerSpy.getAllLogs('warn')).toHaveLength(0);
      });
    });

    it('should support prerelease FHIR R5 dependencies', async () => {
      const config = cloneDeep(minimalConfig);
      config.fhirVersion = ['4.5.0'];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, config).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R5_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r5.core#4.5.0');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r5#9.9.9');
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /support for pre-release versions of FHIR is experimental/s
        );
      });
    });

    it('should support prerelease FHIR R5 snapshot dependencies', async () => {
      const config = cloneDeep(minimalConfig);
      config.fhirVersion = ['5.0.0-snapshot1'];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, config).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R5_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r5.core#5.0.0-snapshot1');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r5#9.9.9');
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /support for pre-release versions of FHIR is experimental/s
        );
      });
    });

    it('should support official FHIR R5 dependency', async () => {
      const config = cloneDeep(minimalConfig);
      config.fhirVersion = ['5.0.0'];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, config).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R5_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r5.core#5.0.0');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.fhir.uv.extensions.r5#9.9.9');
        expect(loggerSpy.getAllLogs('warn')).toHaveLength(0);
      });
    });

    it('should support FHIR current dependencies', async () => {
      const config = cloneDeep(minimalConfig);
      config.fhirVersion = ['current'];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, config).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R5_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r5.core#current');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.fhir.uv.extensions.r5#9.9.9');
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /support for pre-release versions of FHIR is experimental/s
        );
      });
    });

    it('should support implied FHIR extension packages', async () => {
      // We want to do this for each, so make a function we'll just call for each version
      const testExtPackage = async (
        extId: string,
        suppFhirId: string,
        suppFhirVersion: string,
        fhirId: string,
        fhirVersion: string
      ) => {
        const impliedExtensionsConfig = cloneDeep(minimalConfig);
        impliedExtensionsConfig.fhirVersion = [fhirVersion];
        impliedExtensionsConfig.dependencies = [{ packageId: extId, version: fhirVersion }];
        const defs = await getTestFHIRDefinitions();
        const supplementalSpy = jest.spyOn(defs, 'loadSupplementalFHIRPackage');
        return loadExternalDependencies(defs, impliedExtensionsConfig).then(() => {
          const loadedPackages = defs
            .findPackageInfos('*')
            .map(pkg => `${pkg.name}#${pkg.version}`);
          if (fhirVersion === '5.0.0') {
            expect(loadedPackages).toHaveLength(1 + NUM_R5_AUTO_DEPENDENCIES);
            assertAutomaticR5Dependencies(loadedPackages);
          } else {
            expect(loadedPackages).toHaveLength(1 + NUM_R4_AUTO_DEPENDENCIES);
            assertAutomaticR4Dependencies(loadedPackages);
          }
          expect(loadedPackages).toContain(`${fhirId}#${fhirVersion}`);
          expect(supplementalSpy).toHaveBeenCalledExactlyOnceWith(
            `${suppFhirId}#${suppFhirVersion}`
          );
          expect(loggerSpy.getAllLogs('error')).toHaveLength(0);
        });
      };
      await testExtPackage(
        'hl7.fhir.extensions.r2',
        'hl7.fhir.r2.core',
        '1.0.2',
        'hl7.fhir.r5.core',
        '5.0.0'
      );
      await testExtPackage(
        'hl7.fhir.extensions.r3',
        'hl7.fhir.r3.core',
        '3.0.2',
        'hl7.fhir.r5.core',
        '5.0.0'
      );
      await testExtPackage(
        'hl7.fhir.extensions.r4',
        'hl7.fhir.r4.core',
        '4.0.1',
        'hl7.fhir.r5.core',
        '5.0.0'
      );
      await testExtPackage(
        'hl7.fhir.extensions.r5',
        'hl7.fhir.r5.core',
        '5.0.0',
        'hl7.fhir.r4.core',
        '4.0.1'
      );
    });

    it('should log a warning if wrong implied FHIR extension package version is used', async () => {
      const impliedExtensionsConfig = cloneDeep(minimalConfig);
      impliedExtensionsConfig.fhirVersion = ['5.0.0'];
      impliedExtensionsConfig.dependencies = [
        { packageId: 'hl7.fhir.extensions.r2', version: '1.0.2' }
      ];
      const defs = await getTestFHIRDefinitions();
      const supplementalSpy = jest.spyOn(defs, 'loadSupplementalFHIRPackage');
      return loadExternalDependencies(defs, impliedExtensionsConfig).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R5_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r5.core#5.0.0');
        assertAutomaticR5Dependencies(loadedPackages);
        expect(supplementalSpy).toHaveBeenCalledExactlyOnceWith('hl7.fhir.r2.core#1.0.2');
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /Incorrect package version: hl7\.fhir\.extensions\.r2#1\.0\.2\./
        );
        expect(loggerSpy.getAllLogs('error')).toHaveLength(0);
      });
    });

    it('should log an error when it fails to load a dependency', async () => {
      const badDependencyConfig = cloneDeep(minimalConfig);
      badDependencyConfig.dependencies = [{ packageId: 'hl7.does.not.exist', version: 'current' }];
      const defs = await getTestFHIRDefinitions();
      defs.currentBuildClientMock.downloadCurrentBuild
        .mockReset()
        .calledWith('hl7.does.not.exist')
        .mockRejectedValue(new Error());
      return loadExternalDependencies(defs, badDependencyConfig).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r4.core#4.0.1');
        assertAutomaticR4Dependencies(loadedPackages);
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /Failed to load hl7\.does\.not\.exist#current/s
        );
        // But don't log the error w/ details about proxies
        expect(loggerSpy.getLastMessage('error')).not.toMatch(/SSL/s);
      });
    });

    it('should log a more detailed error when it fails to load a dependency due to certificate issue', async () => {
      const selfSignedDependencyConfig = cloneDeep(minimalConfig);
      selfSignedDependencyConfig.dependencies = [
        { packageId: 'self-signed.package', version: '1.0.0' }
      ];
      const defs = await getTestFHIRDefinitions();
      defs.registryClientMock.download
        .mockReset()
        .calledWith('self-signed.package', '1.0.0')
        .mockRejectedValue(new Error('self signed certificate in certificate chain'));
      return loadExternalDependencies(defs, selfSignedDependencyConfig).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r4.core#4.0.1');
        assertAutomaticR4Dependencies(loadedPackages);
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /Failed to load self-signed\.package#1\.0\.0/s
        );
        // AND it should log the detailed message about SSL
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /Sometimes this error occurs in corporate or educational environments that use proxies and\/or SSL inspection/s
        );
      });
    });

    it('should log an error when a dependency has no specified version', async () => {
      const badDependencyConfig = cloneDeep(minimalConfig);
      badDependencyConfig.dependencies = [{ packageId: 'hl7.fhir.r4.core' }];
      const defs = await getTestFHIRDefinitions();
      return loadExternalDependencies(defs, badDependencyConfig).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(1 + NUM_R4_AUTO_DEPENDENCIES);
        expect(loadedPackages).toContain('hl7.fhir.r4.core#4.0.1');
        assertAutomaticR4Dependencies(loadedPackages);
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /Failed to load hl7\.fhir\.r4\.core: No version specified\./s
        );
        // But don't log the error w/ details about proxies
        expect(loggerSpy.getLastMessage('error')).not.toMatch(/SSL/s);
      });
    });
  });

  describe('#loadAutomaticDependencies', () => {
    beforeEach(() => {
      loggerSpy.reset();
    });

    it('should load each automatic dependency for FHIR R4', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies('4.0.1', config.dependencies, defs).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(4);
        expect(loadedPackages).toContain('sushi-r5forR4#1.0.0');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r4#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r4#9.9.9');
        expect(loadedPackages).toContain('hl7.fhir.uv.extensions.r4#9.9.9');
        expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
      });
    });

    it('should load each automatic dependency for FHIR R4B', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies('4.3.0', config.dependencies, defs).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(4);
        expect(loadedPackages).toContain('sushi-r5forR4#1.0.0');
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r4#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r4#9.9.9');
        expect(loadedPackages).toContain('hl7.fhir.uv.extensions.r4#9.9.9');
        expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
      });
    });

    it('should load each automatic dependency for FHIR R5 Final Draft', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies('5.0.0-draft-final', config.dependencies, defs).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(3);
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.fhir.uv.extensions.r5#9.9.9');
        expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
      });
    });

    it('should load each automatic dependency for FHIR R5', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies('5.0.0', config.dependencies, defs).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(3);
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.fhir.uv.extensions.r5#9.9.9');
        expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
      });
    });

    it('should load each automatic dependency for FHIR R6 prerelease', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies('6.0.0-ballot2', config.dependencies, defs).then(() => {
        const loadedPackages = defs.findPackageInfos('*').map(pkg => `${pkg.name}#${pkg.version}`);
        expect(loadedPackages).toHaveLength(3);
        expect(loadedPackages).toContain('hl7.fhir.uv.tools.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.terminology.r5#9.9.9');
        expect(loadedPackages).toContain('hl7.fhir.uv.extensions.r5#9.9.9');
        expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
      });
    });

    it('should not load dependencies that are present in the config', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.uv.tools.r4', version: '2.2.0-test' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies(config.fhirVersion[0], config.dependencies, defs).then(
        () => {
          const loadedPackages = defs
            .findPackageInfos('*')
            .map(pkg => `${pkg.name}#${pkg.version}`);
          expect(loadedPackages).toHaveLength(NUM_R4_AUTO_DEPENDENCIES - 1);
          expect(loadedPackages).not.toContain('hl7.fhir.uv.tools.r4#9.9.9');
          expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
        }
      );
    });

    it('should not load dependencies that are present in the config even if they do not have an r{x} suffix and the auto dependency does', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.terminology', version: '4.0.0-test' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies(config.fhirVersion[0], config.dependencies, defs).then(
        () => {
          const loadedPackages = defs
            .findPackageInfos('*')
            .map(pkg => `${pkg.name}#${pkg.version}`);
          expect(loadedPackages).toHaveLength(NUM_R4_AUTO_DEPENDENCIES - 1);
          expect(loadedPackages).not.toContain('hl7.terminology.r4#1.2.3-test');
          expect(loadedPackages).not.toContain('hl7.terminology.r4#latest');
          expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
        }
      );
    });

    it('should not load dependencies that are present in the config even if they do have an r{x} suffix that does not match the auto dependency r{x} suffix', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.terminology.r5', version: '4.0.0-test' }];
      const defs = await getTestFHIRDefinitions();
      return loadAutomaticDependencies(config.fhirVersion[0], config.dependencies, defs).then(
        () => {
          const loadedPackages = defs
            .findPackageInfos('*')
            .map(pkg => `${pkg.name}#${pkg.version}`);
          expect(loadedPackages).toHaveLength(NUM_R4_AUTO_DEPENDENCIES - 1);
          expect(loadedPackages).not.toContain('hl7.terminology.r4#1.2.3-test');
          expect(loadedPackages).not.toContain('hl7.terminology.r4#latest');
          expect(loggerSpy.getAllMessages('warn')).toHaveLength(0);
        }
      );
    });

    it('should log a warning when it fails to load an automatic dependency', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      defs.registryClientMock.download
        .mockReset()
        .calledWith('hl7.fhir.uv.tools.r4', '9.9.9')
        .mockRejectedValue(new Error());
      return loadAutomaticDependencies(config.fhirVersion[0], config.dependencies, defs).then(
        () => {
          const loadedPackages = defs
            .findPackageInfos('*')
            .map(pkg => `${pkg.name}#${pkg.version}`);
          expect(loadedPackages).toHaveLength(NUM_R4_AUTO_DEPENDENCIES - 1);
          expect(loadedPackages).not.toContain('hl7.fhir.uv.tools.r4#9.9.9');
          expect(loggerSpy.getAllMessages('warn')).toHaveLength(1);
          expect(loggerSpy.getLastMessage('warn')).toMatch(
            /Failed to load automatically-provided hl7\.fhir\.uv\.tools\.r4#latest/s
          );
          // But don't log the warning w/ details about proxies
          expect(loggerSpy.getLastMessage('warn')).not.toMatch(/SSL/s);
          // And don't log an error
          expect(loggerSpy.getAllLogs('error')).toHaveLength(0);
        }
      );
    });

    it('should log a warning when it fails to find the latest version of an automatic dependency due to an error', async () => {
      const config = cloneDeep(minimalConfig);
      config.dependencies = [{ packageId: 'hl7.fhir.us.core', version: '3.1.0' }];
      const defs = await getTestFHIRDefinitions();
      defs.registryClientMock.resolveVersion
        .mockReset()
        .mockImplementation((name: string, version: string) => {
          if (name === 'hl7.terminology.r4' && version === 'latest') {
            return Promise.reject(new Error());
          }
          return Promise.resolve(version === 'latest' ? '9.9.9' : version);
        });
      return loadAutomaticDependencies(config.fhirVersion[0], config.dependencies, defs).then(
        () => {
          const loadedPackages = defs
            .findPackageInfos('*')
            .map(pkg => `${pkg.name}#${pkg.version}`);
          expect(loadedPackages).toHaveLength(NUM_R4_AUTO_DEPENDENCIES - 1);
          expect(loadedPackages).not.toContain('hl7.terminology.r4#4.0.0');
          expect(loggerSpy.getAllMessages('warn')).toHaveLength(1);
          expect(loggerSpy.getLastMessage('warn')).toMatch(
            /Failed to load automatically-provided hl7\.terminology\.r4#latest/s
          );
          // But don't log the warning w/ details about proxies
          expect(loggerSpy.getLastMessage('warn')).not.toMatch(/SSL/s);
          // And don't log an error
          expect(loggerSpy.getAllLogs('error')).toHaveLength(0);
        }
      );
    });
  });

  describe('#getRawFSHes()', () => {
    it('should return a RawFSH for each file in the input directory that ends with .fsh', () => {
      const input = path.join(__dirname, 'fixtures', 'fsh-files');
      const rawFSHes = getRawFSHes(input);
      expect(rawFSHes.length).toBe(2);
      expect(rawFSHes).toContainEqual({
        content: '// Content of first file',
        path: path.join(input, 'first.fsh')
      });
      expect(rawFSHes).toContainEqual({
        content: '// Content of second file',
        path: path.join(input, 'second.fsh')
      });
    });

    it('should log and throw an error when the input path is invalid', () => {
      const input = path.join(__dirname, 'fixtures', 'wrong-path');
      expect(() => {
        getRawFSHes(input);
      }).toThrow();
      expect(loggerSpy.getLastMessage('error')).toMatch(/Invalid path to FSH definition folder\./s);
    });

    describe('#symlinks', () => {
      const linkPath = path.join(__dirname, 'fixtures', 'fsh-files', 'myLock.fsh');
      const linkTarget = path.join(__dirname, 'fixtures', 'fsh-files', 'meaninglessTarget');

      beforeAll(() => {
        try {
          fs.removeSync(linkPath);
        } catch {
          // This will fail if the link doesn't exist, which is fine.
          // We just want to be extra sure to clean up before making it.
        }
        try {
          fs.symlinkSync(linkTarget, linkPath);
        } catch {
          // This may fail if the user running the test doesn't have permission to create a symbolic link.
          // On Windows systems, normal users do not have this permission.
        }
      });

      it('should return a RawFSH for each real file in the input directory that ends with .fsh', () => {
        const input = path.join(__dirname, 'fixtures', 'fsh-files');
        const rawFSHes = getRawFSHes(input);
        expect(rawFSHes.length).toBe(2);
        expect(rawFSHes).toContainEqual({
          content: '// Content of first file',
          path: path.join(input, 'first.fsh')
        });
        expect(rawFSHes).toContainEqual({
          content: '// Content of second file',
          path: path.join(input, 'second.fsh')
        });
      });

      afterAll(() => {
        try {
          fs.removeSync(linkPath);
        } catch {
          // This will fail if someone removed the link in the middle of the test.
        }
      });
    });
  });

  describe('#hasFshFiles()', () => {
    let tempRoot: string;

    beforeAll(() => {
      tempRoot = temp.mkdirSync('sushi-test');
      fs.mkdirSync(path.join(tempRoot, 'some-fsh'));
      fs.mkdirSync(path.join(tempRoot, 'some-fsh', 'nested'));
      fs.ensureFileSync(path.join(tempRoot, 'some-fsh', 'notfsh.txt'));
      fs.ensureFileSync(path.join(tempRoot, 'some-fsh', 'nested', 'myfsh.fsh'));
      fs.mkdirSync(path.join(tempRoot, 'no-fsh'));
      fs.mkdirSync(path.join(tempRoot, 'no-fsh', 'nested'));
      fs.ensureFileSync(path.join(tempRoot, 'no-fsh', 'notfsh.txt'));
      fs.ensureFileSync(path.join(tempRoot, 'no-fsh', 'nested', 'notfsh.txt'));
    });

    afterAll(() => {
      temp.cleanupSync();
    });

    it('should return true if FSH files exist in any subdirectory', () => {
      const result = hasFshFiles(path.join(tempRoot, 'some-fsh'));
      expect(result).toBe(true);
    });

    it('should return false if there are no FSH files in any subdirectory', () => {
      const result = hasFshFiles(path.join(tempRoot, 'no-fsh'));
      expect(result).toBe(false);
    });
  });

  describe('#checkNullValuesOnArray', () => {
    beforeEach(() => {
      loggerSpy.reset();
    });

    it('should log a warning when a resource includes null values in a top-level array', () => {
      const exInstance = new InstanceDefinition();
      exInstance.resourceType = 'Profile';
      exInstance.id = 'example-instance';
      exInstance.name = [null, 'John', null, 'Doe', null];
      checkNullValuesOnArray(exInstance);
      expect(loggerSpy.getAllMessages()).toHaveLength(1);
      expect(loggerSpy.getLastMessage('warn')).toEqual(
        "The array 'name' in example-instance is missing values at the following indices: 0,2,4"
      );
    });

    it('should log a warning when a resource includes null values in a nested array', () => {
      const exInstance = new InstanceDefinition();
      exInstance.resourceType = 'Profile';
      exInstance.id = 'example-instance';
      const nameObj = {
        testNames: [null, 'John', null, 'Doe', null]
      };
      exInstance.name = nameObj;
      checkNullValuesOnArray(exInstance);
      expect(loggerSpy.getAllMessages()).toHaveLength(1);
      expect(loggerSpy.getLastMessage('warn')).toEqual(
        "The array 'name.testNames' in example-instance is missing values at the following indices: 0,2,4"
      );
    });

    it('should log a warning when a resource includes null values in an array, nested within both objects and arrays ', () => {
      const exInstance = new InstanceDefinition();
      exInstance.resourceType = 'Profile';
      exInstance.id = 'example-instance';
      const nameObj = {
        foo: [
          {
            coding: [
              null, // this is bad
              { system: 'http://foo.org', code: 'bar' }
            ]
          }
        ]
      };
      exInstance.name = nameObj;
      checkNullValuesOnArray(exInstance);
      expect(loggerSpy.getAllMessages()).toHaveLength(1);
      expect(loggerSpy.getLastMessage('warn')).toEqual(
        "The array 'name.foo[0].coding' in example-instance is missing values at the following indices: 0"
      );
    });

    it('should ignore null values on primitive arrays, but warn on null values in nested arrays', () => {
      const exInstance = new InstanceDefinition();
      exInstance.resourceType = 'Profile';
      exInstance.id = 'example-instance';
      const nameObj = {
        _foo: [
          null, // this is ok
          {
            extension: [
              null, // this is NOT ok
              { url: 'http://foo.org', valueBoolean: true }
            ]
          }
        ]
      };
      exInstance.name = nameObj;
      checkNullValuesOnArray(exInstance);
      expect(loggerSpy.getAllMessages()).toHaveLength(1);
      expect(loggerSpy.getLastMessage('warn')).toEqual(
        "The array 'name._foo[1].extension' in example-instance is missing values at the following indices: 0"
      );
    });

    it('should not log a warning when a resource includes null values in an array prefixed with an underscore', () => {
      const exInstance = new InstanceDefinition();
      exInstance.resourceType = 'Profile';
      exInstance.id = 'example-instance';
      exInstance._name = [null, 'John', null, 'Doe', null];
      checkNullValuesOnArray(exInstance);
      expect(loggerSpy.getAllMessages()).toHaveLength(0);
    });

    it('should log a warning when a resource includes null values in an array nested within an object prefixed with an underscore', () => {
      const exInstance = new InstanceDefinition();
      exInstance.resourceType = 'Profile';
      exInstance.id = 'example-instance';
      const nameObj = {
        testNames: [null, 'John', null, 'Doe', null]
      };
      exInstance._name = nameObj;
      checkNullValuesOnArray(exInstance);
      expect(loggerSpy.getAllMessages()).toHaveLength(1);
      expect(loggerSpy.getLastMessage('warn')).toEqual(
        "The array '_name.testNames' in example-instance is missing values at the following indices: 0,2,4"
      );
    });
  });

  describe('#writeFHIRResources()', () => {
    let tempIGPubRoot: string;
    let outPackage: Package;
    let defs: FHIRDefinitions;

    beforeAll(async () => {
      tempIGPubRoot = temp.mkdirSync('output-ig-dir');
      const input = path.join(__dirname, 'fixtures', 'valid-yaml');
      const config = readConfig(input);
      outPackage = new Package(config);
      defs = await getTestFHIRDefinitions();

      const predefinedResourceMap = new Map<string, any>();
      const myPredefinedProfile = new StructureDefinition();
      myPredefinedProfile.id = 'my-duplicate-profile';
      myPredefinedProfile.url = 'http://example.com/StructureDefinition/my-duplicate-profile';
      predefinedResourceMap.set('my-duplicate-profile', myPredefinedProfile.toJSON(true));
      const myPredefinedInstance = new InstanceDefinition();
      myPredefinedInstance.id = 'my-duplicate-instance';
      myPredefinedInstance.resourceType = 'Patient';
      predefinedResourceMap.set('my-duplicate-instance', myPredefinedInstance.toJSON());
      const predefinedPkg = new InMemoryVirtualPackage(
        { name: PREDEFINED_PACKAGE_NAME, version: PREDEFINED_PACKAGE_VERSION },
        predefinedResourceMap,
        { log: logMessage, allowNonResources: true }
      );
      await defs.loadVirtualPackage(predefinedPkg);

      const myProfile = new StructureDefinition();
      myProfile.id = 'my-profile';
      const myExtension = new StructureDefinition();
      myExtension.id = 'my-extension';
      const myLogical = new StructureDefinition();
      myLogical.id = 'my-logical';
      const myResource = new StructureDefinition();
      myResource.id = 'my-resource';
      const myValueSet = new ValueSet();
      myValueSet.id = 'my-value-set';
      const myCodeSystem = new CodeSystem();
      myCodeSystem.id = 'my-code-system';

      const myInlineInstance = new InstanceDefinition();
      myInlineInstance.id = 'my-inline-instance';
      myInlineInstance._instanceMeta.usage = 'Inline';
      const myExampleInstance = new InstanceDefinition();
      myExampleInstance.id = 'my-example';
      myExampleInstance.resourceType = 'Observation';
      myExampleInstance._instanceMeta.usage = 'Example';
      const myCapabilityStatement = new InstanceDefinition();
      myCapabilityStatement.id = 'my-capabilities';
      myCapabilityStatement.resourceType = 'CapabilityStatement';
      const myConceptMap = new InstanceDefinition();
      myConceptMap.id = 'my-concept-map';
      myConceptMap.resourceType = 'ConceptMap';
      const myModelInstance = new InstanceDefinition();
      myModelInstance.id = 'my-model';
      myModelInstance.resourceType = 'StructureDefinition';
      myModelInstance.kind = 'logical';
      const myOperationDefinition = new InstanceDefinition();
      myOperationDefinition.id = 'my-operation';
      myOperationDefinition.resourceType = 'OperationDefinition';
      const myExtensionInstance = new InstanceDefinition();
      myExtensionInstance.id = 'my-extension-instance';
      myExtensionInstance.resourceType = 'StructureDefinition';
      myExtensionInstance.kind = 'resource';
      myExtensionInstance.type = 'Extension';
      const myProfileInstance = new InstanceDefinition();
      myProfileInstance.id = 'my-profile-instance';
      myProfileInstance.resourceType = 'StructureDefinition';
      myProfileInstance.kind = 'resource';
      myProfileInstance.type = 'Observation';
      const myOtherInstance = new InstanceDefinition();
      myOtherInstance.id = 'my-other-instance';
      myOtherInstance.resourceType = 'Observation';
      const myInstanceOfLogical = new InstanceDefinition();
      myInstanceOfLogical.id = 'my-instance-of-logical';
      myInstanceOfLogical.resourceType = 'http://example.com/StructureDefinition/some-logical';
      myInstanceOfLogical._instanceMeta.sdType =
        'http://example.com/StructureDefinition/some-logical';
      myInstanceOfLogical._instanceMeta.sdKind = 'logical';
      // duplicate of predefined resource added earlier
      const myFSHDefinedProfile = new StructureDefinition();
      myFSHDefinedProfile.id = 'my-duplicate-profile';
      myFSHDefinedProfile.url = 'http://example.com/StructureDefinition/my-duplicate-profile';
      // duplicate of predefined resource added earlier
      const myFSHDefinedInstance = new InstanceDefinition();
      myFSHDefinedInstance.id = 'my-duplicate-instance';
      myFSHDefinedInstance.resourceType = 'Patient';

      outPackage.profiles.push(myProfile, myFSHDefinedProfile);
      outPackage.extensions.push(myExtension);
      outPackage.logicals.push(myLogical);
      outPackage.resources.push(myResource);
      outPackage.valueSets.push(myValueSet);
      outPackage.codeSystems.push(myCodeSystem);
      outPackage.instances.push(
        myInlineInstance,
        myExampleInstance,
        myCapabilityStatement,
        myConceptMap,
        myModelInstance,
        myOperationDefinition,
        myExtensionInstance,
        myProfileInstance,
        myOtherInstance,
        myInstanceOfLogical,
        myFSHDefinedInstance
      );
    });

    afterAll(() => {
      temp.cleanupSync();
    });

    describe('return value', () => {
      afterEach(() => {
        temp.cleanupSync();
      });

      it('should return a list of filenames for skipped resources', () => {
        const { skippedResources } = writeFHIRResources(tempIGPubRoot, outPackage, defs, false);
        expect(skippedResources).toHaveLength(2);
        expect(skippedResources).toContain('StructureDefinition-my-duplicate-profile.json');
        expect(skippedResources).toContain('Patient-my-duplicate-instance.json');
      });
    });

    describe('IG Publisher mode', () => {
      beforeAll(() => {
        writeFHIRResources(tempIGPubRoot, outPackage, defs, false);
      });

      afterAll(() => {
        temp.cleanupSync();
      });

      it('should write all resources to the "fsh-generated/resources" directory', () => {
        const generatedPath = path.join(tempIGPubRoot, 'fsh-generated', 'resources');
        expect(fs.existsSync(generatedPath)).toBeTruthy();
        const allGeneratedFiles = fs.readdirSync(generatedPath);
        expect(allGeneratedFiles.length).toBe(15);
        expect(allGeneratedFiles).toContain('StructureDefinition-my-profile.json');
        expect(allGeneratedFiles).toContain('StructureDefinition-my-profile-instance.json');
        expect(allGeneratedFiles).toContain('StructureDefinition-my-extension.json');
        expect(allGeneratedFiles).toContain('StructureDefinition-my-extension-instance.json');
        expect(allGeneratedFiles).toContain('StructureDefinition-my-logical.json');
        expect(allGeneratedFiles).toContain('StructureDefinition-my-resource.json');
        expect(allGeneratedFiles).toContain('ValueSet-my-value-set.json');
        expect(allGeneratedFiles).toContain('CodeSystem-my-code-system.json');
        expect(allGeneratedFiles).toContain('ConceptMap-my-concept-map.json');
        expect(allGeneratedFiles).toContain('Observation-my-example.json');
        expect(allGeneratedFiles).toContain('CapabilityStatement-my-capabilities.json');
        expect(allGeneratedFiles).toContain('StructureDefinition-my-model.json');
        expect(allGeneratedFiles).toContain('OperationDefinition-my-operation.json');
        expect(allGeneratedFiles).toContain('Observation-my-other-instance.json');
        // NOTE: Instances of logicals are always output as Binary-{id} regardless of type
        expect(allGeneratedFiles).toContain('Binary-my-instance-of-logical.json');
        expect(loggerSpy.getLastMessage('info')).toMatch(/Exported 15 FHIR resources/s);
      });

      it('should not allow devious characters in the resource file names', () => {
        const tempDeviousIGPubRoot = temp.mkdirSync('output-ig-dir');
        const deviousOutPackage = cloneDeep(outPackage);
        deviousOutPackage.profiles.forEach(d => (d.id = `/../../devious/${d.id}`));
        deviousOutPackage.extensions.forEach(d => (d.id = `/../../devious/${d.id}`));
        deviousOutPackage.logicals.forEach(d => (d.id = `/../../devious/${d.id}`));
        deviousOutPackage.resources.forEach(d => (d.id = `/../../devious/${d.id}`));
        deviousOutPackage.valueSets.forEach(d => (d.id = `/../../devious/${d.id}`));
        deviousOutPackage.codeSystems.forEach(d => (d.id = `/../../devious/${d.id}`));
        deviousOutPackage.instances.forEach(d => (d.id = `/../../devious/${d.id}`));
        writeFHIRResources(tempDeviousIGPubRoot, deviousOutPackage, defs, false);

        // Make sure we didn't create the devious path
        const deviousPath = path.join(tempDeviousIGPubRoot, 'fsh-generated', 'devious');
        expect(fs.existsSync(deviousPath)).toBe(false);

        // Make sure we do have all the good file names
        const angelicPath = path.join(tempDeviousIGPubRoot, 'fsh-generated', 'resources');
        expect(fs.existsSync(angelicPath)).toBeTruthy();
        const allAngelicFiles = fs.readdirSync(angelicPath);
        expect(allAngelicFiles.length).toBe(17);
        expect(allAngelicFiles).toContain(
          'CapabilityStatement--..-..-devious-my-capabilities.json'
        );
        expect(allAngelicFiles).toContain('CodeSystem--..-..-devious-my-code-system.json');
        expect(allAngelicFiles).toContain('ConceptMap--..-..-devious-my-concept-map.json');
        expect(allAngelicFiles).toContain('Observation--..-..-devious-my-example.json');
        expect(allAngelicFiles).toContain('Observation--..-..-devious-my-other-instance.json');
        // NOTE: Instances of logicals are always output as Binary-{id} regardless of type
        expect(allAngelicFiles).toContain('Binary--..-..-devious-my-instance-of-logical.json');
        expect(allAngelicFiles).toContain('OperationDefinition--..-..-devious-my-operation.json');
        expect(allAngelicFiles).toContain('Patient--..-..-devious-my-duplicate-instance.json');
        expect(allAngelicFiles).toContain(
          'StructureDefinition--..-..-devious-my-duplicate-profile.json'
        );
        expect(allAngelicFiles).toContain(
          'StructureDefinition--..-..-devious-my-extension-instance.json'
        );
        expect(allAngelicFiles).toContain('StructureDefinition--..-..-devious-my-extension.json');
        expect(allAngelicFiles).toContain('StructureDefinition--..-..-devious-my-logical.json');
        expect(allAngelicFiles).toContain('StructureDefinition--..-..-devious-my-model.json');
        expect(allAngelicFiles).toContain(
          'StructureDefinition--..-..-devious-my-profile-instance.json'
        );
        expect(allAngelicFiles).toContain('StructureDefinition--..-..-devious-my-profile.json');
        expect(allAngelicFiles).toContain('StructureDefinition--..-..-devious-my-resource.json');
        expect(allAngelicFiles).toContain('ValueSet--..-..-devious-my-value-set.json');
        expect(loggerSpy.getLastMessage('info')).toMatch(/Exported 17 FHIR resources/s);
      });

      it('should not write a resource if that resource already exists in the "input" folder', () => {
        expect(
          fs.existsSync(
            path.join(
              tempIGPubRoot,
              'fsh-generated',
              'resources',
              'StructureDefinition-my-duplicate-profile.json'
            )
          )
        ).toBeFalsy();
        expect(
          loggerSpy
            .getAllMessages('error')
            .some(error => error.match(/Ignoring FSH definition for .*my-duplicate-profile/))
        ).toBeTruthy();
        expect(
          fs.existsSync(
            path.join(
              tempIGPubRoot,
              'fsh-generated',
              'resources',
              'Patient-my-duplicate-instance.json'
            )
          )
        ).toBeFalsy();
        expect(
          loggerSpy
            .getAllMessages('error')
            .some(error => error.match(/Ignoring FSH definition for .*my-duplicate-instance/))
        ).toBeTruthy();
      });
    });
  });

  describe('#writeFSHIndex()', () => {
    let tempIGPubRoot: string;
    let fshRoot: string;
    let outPackage: Package;

    beforeAll(() => {
      tempIGPubRoot = temp.mkdirSync('output-ig-dir');
      const input = path.join(__dirname, 'fixtures', 'valid-yaml');
      fshRoot = path.join(input, 'good-ig', 'input', 'fsh');
      const config = readConfig(input);
      outPackage = new Package(config);

      outPackage.fshMap.set('StructureDefinition-my-profile.json', {
        fshName: 'MyProfile',
        fshType: 'Profile',
        file: path.join(fshRoot, 'SomeThings.fsh'),
        location: {
          startLine: 1,
          startColumn: 1,
          endLine: 5,
          endColumn: 28
        }
      });

      outPackage.fshMap.set('StructureDefinition-my-extension.json', {
        fshName: 'MyExtension',
        fshType: 'Extension',
        file: path.join(fshRoot, 'SomeThings.fsh'),
        location: {
          startLine: 7,
          startColumn: 1,
          endLine: 15,
          endColumn: 23
        }
      });

      outPackage.fshMap.set('Questionnaire-my-questions.json', {
        fshName: 'MyQuestions',
        fshType: 'Instance',
        file: path.join(fshRoot, 'Questions.fsh'),
        location: {
          startLine: 2,
          startColumn: 1,
          endLine: 28,
          endColumn: 28
        }
      });

      outPackage.fshMap.set('Observation-secret-observation.json', {
        fshName: 'SecretObservation',
        fshType: 'Instance',
        file: path.join(fshRoot, 'secrets', 'SecretThings.fsh'),
        location: {
          startLine: 2,
          startColumn: 1,
          endLine: 39,
          endColumn: 55
        }
      });
    });

    it('should create text and json index files that contain each resource in the package', () => {
      writeFSHIndex(tempIGPubRoot, outPackage, fshRoot, []);
      const textIndex = path.join(tempIGPubRoot, 'fsh-generated', 'fsh-index.txt');
      const jsonIndex = path.join(tempIGPubRoot, 'fsh-generated', 'data', 'fsh-index.json');
      expect(fs.existsSync(textIndex)).toBeTrue();
      expect(fs.existsSync(jsonIndex)).toBeTrue();

      const textContents = fs.readFileSync(textIndex, 'utf-8');
      expect(textContents).toMatch(
        /StructureDefinition-my-profile\.json\s+MyProfile\s+Profile\s+SomeThings\.fsh\s+1 - 5/s
      );
      expect(textContents).toMatch(
        /StructureDefinition-my-extension\.json\s+MyExtension\s+Extension\s+SomeThings\.fsh\s+7 - 15/s
      );
      expect(textContents).toMatch(
        /Questionnaire-my-questions\.json\s+MyQuestions\s+Instance\s+Questions\.fsh\s+2 - 28/s
      );
      const secretRegex = new RegExp(
        `Observation-secret-observation\\.json\\s+SecretObservation\\s+Instance\\s+secrets\\${path.sep}SecretThings\\.fsh\\s+2 - 39`,
        's'
      );
      expect(textContents).toMatch(secretRegex);

      const jsonContents = fs.readJsonSync(jsonIndex);
      expect(jsonContents).toHaveLength(4);
      expect(jsonContents).toContainEqual({
        fshFile: 'SomeThings.fsh',
        fshName: 'MyProfile',
        fshType: 'Profile',
        startLine: 1,
        endLine: 5,
        outputFile: 'StructureDefinition-my-profile.json'
      });
      expect(jsonContents).toContainEqual({
        fshFile: 'SomeThings.fsh',
        fshName: 'MyExtension',
        fshType: 'Extension',
        startLine: 7,
        endLine: 15,
        outputFile: 'StructureDefinition-my-extension.json'
      });
      expect(jsonContents).toContainEqual({
        fshFile: 'Questions.fsh',
        fshName: 'MyQuestions',
        fshType: 'Instance',
        startLine: 2,
        endLine: 28,
        outputFile: 'Questionnaire-my-questions.json'
      });
      expect(jsonContents).toContainEqual({
        fshFile: path.join('secrets', 'SecretThings.fsh'),
        fshName: 'SecretObservation',
        fshType: 'Instance',
        startLine: 2,
        endLine: 39,
        outputFile: 'Observation-secret-observation.json'
      });
    });

    it('should sort the list of resources by output file name', () => {
      writeFSHIndex(tempIGPubRoot, outPackage, fshRoot, []);
      const textIndex = path.join(tempIGPubRoot, 'fsh-generated', 'fsh-index.txt');
      const jsonIndex = path.join(tempIGPubRoot, 'fsh-generated', 'data', 'fsh-index.json');
      expect(fs.existsSync(textIndex)).toBeTrue();
      expect(fs.existsSync(jsonIndex)).toBeTrue();

      const textContents = fs.readFileSync(textIndex, 'utf-8');
      const myProfilePosition = textContents.indexOf('StructureDefinition-my-profile.json');
      const myExtensionPosition = textContents.indexOf('StructureDefinition-my-extension.json');
      const myQuestionsPosition = textContents.indexOf('Questionnaire-my-questions.json');
      const secretObservationPosition = textContents.indexOf('Observation-secret-observation.json');
      expect(secretObservationPosition).toBeLessThan(myQuestionsPosition);
      expect(myQuestionsPosition).toBeLessThan(myExtensionPosition);
      expect(myExtensionPosition).toBeLessThan(myProfilePosition);

      const jsonContents = fs.readJsonSync(jsonIndex);
      expect(jsonContents[0].outputFile).toBe('Observation-secret-observation.json');
      expect(jsonContents[1].outputFile).toBe('Questionnaire-my-questions.json');
      expect(jsonContents[2].outputFile).toBe('StructureDefinition-my-extension.json');
      expect(jsonContents[3].outputFile).toBe('StructureDefinition-my-profile.json');
    });

    it('should not include a resource in the package if it is in the list of resources to skip', () => {
      writeFSHIndex(tempIGPubRoot, outPackage, fshRoot, ['StructureDefinition-my-extension.json']);
      const textIndex = path.join(tempIGPubRoot, 'fsh-generated', 'fsh-index.txt');
      const jsonIndex = path.join(tempIGPubRoot, 'fsh-generated', 'data', 'fsh-index.json');
      expect(fs.existsSync(textIndex)).toBeTrue();
      expect(fs.existsSync(jsonIndex)).toBeTrue();

      const textContents = fs.readFileSync(textIndex, 'utf-8');
      expect(textContents).toMatch(
        /StructureDefinition-my-profile\.json\s+MyProfile\s+Profile\s+SomeThings\.fsh\s+1 - 5/s
      );
      expect(textContents).toMatch(
        /Questionnaire-my-questions\.json\s+MyQuestions\s+Instance\s+Questions\.fsh\s+2 - 28/s
      );
      const secretRegex = new RegExp(
        `Observation-secret-observation\\.json\\s+SecretObservation\\s+Instance\\s+secrets\\${path.sep}SecretThings\\.fsh\\s+2 - 39`,
        's'
      );
      expect(textContents).toMatch(secretRegex);

      expect(textContents).not.toMatch('MyExtension');

      const jsonContents = fs.readJsonSync(jsonIndex);
      expect(jsonContents).toHaveLength(3);
      expect(jsonContents).toContainEqual({
        fshFile: 'SomeThings.fsh',
        fshName: 'MyProfile',
        fshType: 'Profile',
        startLine: 1,
        endLine: 5,
        outputFile: 'StructureDefinition-my-profile.json'
      });
      expect(jsonContents).toContainEqual({
        fshFile: 'Questions.fsh',
        fshName: 'MyQuestions',
        fshType: 'Instance',
        startLine: 2,
        endLine: 28,
        outputFile: 'Questionnaire-my-questions.json'
      });
      expect(jsonContents).toContainEqual({
        fshFile: path.join('secrets', 'SecretThings.fsh'),
        fshName: 'SecretObservation',
        fshType: 'Instance',
        startLine: 2,
        endLine: 39,
        outputFile: 'Observation-secret-observation.json'
      });
      expect(jsonContents).not.toContainEqual({
        fshFile: 'SomeThings.fsh',
        fshName: 'MyExtension',
        fshType: 'Extension',
        startLine: 7,
        endLine: 15,
        outputFile: 'StructureDefinition-my-extension.json'
      });
    });
  });

  describe('#writePreprocessedFSH', () => {
    let tank: FSHTank;
    let tempIn: string;
    let tempOut: string;

    beforeAll(() => {
      tempIn = temp.mkdirSync('input-dir');
      tempOut = temp.mkdirSync('output-dir');
      const firstDoc = new FSHDocument(path.join(tempIn, 'first.fsh'));
      firstDoc.aliases.set('LOINC', 'http://loinc.org');
      firstDoc.profiles.set('MyProfile', new Profile('MyProfile').withLocation([3, 0, 15, 7]));
      firstDoc.extensions.set(
        'MyExtension',
        new Extension('MyExtension').withLocation([17, 0, 20, 8])
      );
      firstDoc.logicals.set('MyLogical', new Logical('MyLogical').withLocation([31, 0, 39, 23]));
      const secondDoc = new FSHDocument(path.join(tempIn, 'second.fsh'));
      secondDoc.instances.set(
        'MyInstance',
        new Instance('MyInstance').withLocation([20, 0, 25, 5])
      );
      secondDoc.valueSets.set(
        'MyValueSet',
        new FshValueSet('MyValueSet').withLocation([30, 0, 35, 9])
      );
      secondDoc.codeSystems.set(
        'MyCodeSystem',
        new FshCodeSystem('MyCodeSystem').withLocation([10, 0, 15, 18])
      );
      const thirdDoc = new FSHDocument(path.join(tempIn, 'extra', 'third.fsh'));
      thirdDoc.invariants.set('inv-1', new Invariant('inv-1').withLocation([222, 0, 224, 9]));
      thirdDoc.ruleSets.set('MyRuleSet', new RuleSet('MyRuleSet').withLocation([33, 0, 39, 15]));
      thirdDoc.mappings.set('MyMapping', new Mapping('MyMapping').withLocation([10, 0, 21, 18]));
      thirdDoc.resources.set(
        'MyResource',
        new Resource('MyResource').withLocation([55, 0, 69, 31])
      );
      const ruleSetDoc = new FSHDocument(path.join(tempIn, 'extra', 'rulesets.fsh'));
      ruleSetDoc.ruleSets.set('OneRuleSet', new RuleSet('OneRuleSet').withLocation([8, 0, 18, 35]));
      ruleSetDoc.ruleSets.set(
        'TwoRuleSet',
        new RuleSet('TwoRuleSet').withLocation([20, 0, 35, 21])
      );
      tank = new FSHTank([firstDoc, secondDoc, thirdDoc, ruleSetDoc], null);
      writePreprocessedFSH(tempOut, tempIn, tank);
    });

    afterAll(() => {
      temp.cleanupSync();
    });

    it('should produce files in a structure that mirrors the input', () => {
      expect(fs.existsSync(path.join(tempOut, '_preprocessed', 'first.fsh')));
      expect(fs.existsSync(path.join(tempOut, '_preprocessed', 'second.fsh')));
      expect(fs.existsSync(path.join(tempOut, '_preprocessed', 'extra', 'third.fsh')));
      expect(fs.existsSync(path.join(tempOut, '_preprocessed', 'extra', 'aliases.fsh')));
    });

    it('should write all entities that exist after preprocessing', () => {
      // first.fsh should contain LOINC (an Alias), MyProfile, and MyExtension
      const firstContents = fs.readFileSync(
        path.join(tempOut, '_preprocessed', 'first.fsh'),
        'utf-8'
      );
      expect(firstContents).toMatch('Alias: LOINC');
      expect(firstContents).toMatch(
        `// Originally defined on lines 3 - 15${EOL}Profile: MyProfile`
      );
      expect(firstContents).toMatch(
        `// Originally defined on lines 17 - 20${EOL}Extension: MyExtension`
      );
      expect(firstContents).toMatch(
        `// Originally defined on lines 31 - 39${EOL}Logical: MyLogical`
      );
      // second.fsh should contain MyCodeSystem, MyInstance, and MyValueSet
      const secondContents = fs.readFileSync(
        path.join(tempOut, '_preprocessed', 'second.fsh'),
        'utf-8'
      );
      expect(secondContents).toMatch(
        `// Originally defined on lines 10 - 15${EOL}CodeSystem: MyCodeSystem`
      );
      expect(secondContents).toMatch(
        `// Originally defined on lines 20 - 25${EOL}Instance: MyInstance`
      );
      expect(secondContents).toMatch(
        `// Originally defined on lines 30 - 35${EOL}ValueSet: MyValueSet`
      );
      // third.fsh should contain MyMapping and inv-1
      const thirdContents = fs.readFileSync(
        path.join(tempOut, '_preprocessed', 'extra', 'third.fsh'),
        'utf-8'
      );
      expect(thirdContents).toMatch(
        `// Originally defined on lines 10 - 21${EOL}Mapping: MyMapping`
      );
      expect(thirdContents).toMatch(
        `// Originally defined on lines 222 - 224${EOL}Invariant: inv-1`
      );
      expect(thirdContents).toMatch(
        `// Originally defined on lines 55 - 69${EOL}Resource: MyResource`
      );
      // RuleSets do not exist after preprocessing
      expect(thirdContents).not.toMatch('RuleSet: MyRuleSet');
    });

    it('should write entities in their original order', () => {
      const secondContents = fs.readFileSync(
        path.join(tempOut, '_preprocessed', 'second.fsh'),
        'utf-8'
      );
      const instanceLocation = secondContents.indexOf('Instance: MyInstance');
      const valueSetLocation = secondContents.indexOf('ValueSet: MyValueSet');
      const codeSystemLocation = secondContents.indexOf('CodeSystem: MyCodeSystem');
      expect(instanceLocation).toBeGreaterThan(-1);
      expect(valueSetLocation).toBeGreaterThan(-1);
      expect(codeSystemLocation).toBeGreaterThan(-1);
      expect(codeSystemLocation).toBeLessThan(instanceLocation);
      expect(instanceLocation).toBeLessThan(valueSetLocation);
    });

    it('should write a comment for a file with no entities after preprocessing', () => {
      // A file with only RuleSet definitions will have no content after preprocessing.
      const ruleSetContent = fs.readFileSync(
        path.join(tempOut, '_preprocessed', 'extra', 'rulesets.fsh'),
        'utf-8'
      );
      expect(ruleSetContent).toBe('// This file has no content after preprocessing.');
    });
  });

  describe('#init()', () => {
    let readlineSpy: jest.SpyInstance;
    let yesNoSpy: jest.SpyInstance;
    let writeSpy: jest.SpyInstance;
    let copyFileSpy: jest.SpyInstance;
    let ensureDirSpy: jest.SpyInstance;
    let consoleSpy: jest.SpyInstance;
    let getSpy: jest.SpyInstance;

    beforeEach(() => {
      readlineSpy = jest.spyOn(readlineSync, 'question').mockImplementation(() => '');
      yesNoSpy = jest.spyOn(readlineSync, 'keyInYN').mockImplementation(() => true);
      writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      copyFileSpy = jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {});
      ensureDirSpy = jest.spyOn(fs, 'ensureDirSync').mockImplementation(() => undefined);
      consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      getSpy = jest.spyOn(axios, 'get').mockImplementation(url => {
        return Promise.resolve({ data: url.slice(url.lastIndexOf('/') + 1) });
      });
      readlineSpy.mockClear();
      yesNoSpy.mockClear();
      writeSpy.mockClear();
      copyFileSpy.mockClear();
      ensureDirSpy.mockClear();
      consoleSpy.mockClear();
      getSpy.mockClear();
    });

    it('should initialize a default project when no user input is given', async () => {
      await init();
      expect(readlineSpy.mock.calls).toEqual([
        ['Name (Default: ExampleIG): '],
        ['Id (Default: fhir.example): '],
        ['Canonical (Default: http://example.org): '],
        ['Status (Default: draft): '],
        ['Version (Default: 0.1.0): '],
        ['Release Label (Default: ci-build): '],
        ['Publisher Name (Default: Example Publisher): '],
        ['Publisher Url (Default: http://example.org/example-publisher): ']
      ]);
      expect(yesNoSpy.mock.calls).toHaveLength(1);
      expect(yesNoSpy.mock.calls[0][0]).toMatch(/Initialize SUSHI project in .*ExampleIG/);

      expect(ensureDirSpy.mock.calls).toHaveLength(2);
      expect(ensureDirSpy.mock.calls[0][0]).toMatch(/.*ExampleIG.*input.*pagecontent/);
      expect(ensureDirSpy.mock.calls[1][0]).toMatch(/.*ExampleIG.*input.*fsh/);

      expect(writeSpy.mock.calls).toHaveLength(7);
      expect(writeSpy.mock.calls[0][0]).toMatch(/.*index\.md/);
      expect(writeSpy.mock.calls[0][1]).toMatch(/# ExampleIG/);
      expect(writeSpy.mock.calls[1][0]).toMatch(/.*ig\.ini/);
      expect(writeSpy.mock.calls[1][1]).toMatch(/fhir.example/);
      expect(writeSpy.mock.calls[2][0]).toMatch(/.*sushi-config\.yaml/);
      expect(writeSpy.mock.calls[2][1].replace(/[\n\r]/g, '')).toBe(
        fs
          .readFileSync(
            path.join(__dirname, 'fixtures', 'init-config', 'default-config.yaml'),
            'utf-8'
          )
          .replace(/[\n\r]/g, '')
          .replace('${YEAR}', String(new Date().getFullYear()))
      );

      expect(copyFileSpy.mock.calls).toHaveLength(3);
      expect(copyFileSpy.mock.calls[0][1]).toMatch(/.*ExampleIG.*fsh.*patient.fsh/);
      expect(copyFileSpy.mock.calls[1][1]).toMatch(/.*ExampleIG.*\.gitignore/);
      expect(copyFileSpy.mock.calls[2][1]).toMatch(/.*ExampleIG.*input.*ignoreWarnings\.txt/);

      expect(getSpy.mock.calls).toHaveLength(4);
      const base = 'https://raw.githubusercontent.com/HL7/ig-publisher-scripts/main/';
      expect(getSpy.mock.calls[0][0]).toBe(base + '_genonce.bat');
      expect(getSpy.mock.calls[1][0]).toBe(base + '_genonce.sh');
      expect(getSpy.mock.calls[2][0]).toBe(base + '_updatePublisher.bat');
      expect(getSpy.mock.calls[3][0]).toBe(base + '_updatePublisher.sh');

      expect(writeSpy.mock.calls[3][0]).toMatch(/.*_genonce\.bat/);
      expect(writeSpy.mock.calls[3][1]).toMatch(/_genonce\.bat/);
      expect(writeSpy.mock.calls[4][0]).toMatch(/.*_genonce\.sh/);
      expect(writeSpy.mock.calls[4][1]).toMatch(/_genonce\.sh/);
      expect(writeSpy.mock.calls[5][0]).toMatch(/.*_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[5][1]).toMatch(/_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[6][0]).toMatch(/.*_updatePublisher\.sh/);
      expect(writeSpy.mock.calls[6][1]).toMatch(/_updatePublisher\.sh/);
    });

    it('should initialize a project with user input', async () => {
      readlineSpy.mockImplementation((question: string) => {
        if (question.startsWith('Name')) {
          return 'MyNonDefaultName';
        } else if (question.startsWith('Id')) {
          return 'foo.bar';
        } else if (question.startsWith('Canonical')) {
          return 'http://foo.com';
        } else if (question.startsWith('Status')) {
          return 'active';
        } else if (question.startsWith('Version')) {
          return '2.0.0';
        } else if (question.startsWith('Release Label')) {
          return 'qa-preview';
        } else if (question.startsWith('Publisher Name')) {
          return 'SUSHI Chefs';
        } else if (question.startsWith('Publisher Url')) {
          return 'http://custom-publisher.org';
        }
      });
      await init();
      expect(readlineSpy.mock.calls).toEqual([
        ['Name (Default: ExampleIG): '],
        ['Id (Default: fhir.example): '],
        ['Canonical (Default: http://example.org): '],
        ['Status (Default: draft): '],
        ['Version (Default: 0.1.0): '],
        ['Release Label (Default: ci-build): '],
        ['Publisher Name (Default: Example Publisher): '],
        ['Publisher Url (Default: http://example.org/example-publisher): ']
      ]);
      expect(yesNoSpy.mock.calls).toHaveLength(1);
      expect(yesNoSpy.mock.calls[0][0]).toMatch(/Initialize SUSHI project in .*MyNonDefaultName/);

      expect(ensureDirSpy.mock.calls).toHaveLength(2);
      expect(ensureDirSpy.mock.calls[0][0]).toMatch(/.*MyNonDefaultName.*input.*pagecontent/);
      expect(ensureDirSpy.mock.calls[1][0]).toMatch(/.*MyNonDefaultName.*input.*fsh/);

      expect(writeSpy.mock.calls).toHaveLength(7);
      expect(writeSpy.mock.calls[0][0]).toMatch(/.*index\.md/);
      expect(writeSpy.mock.calls[0][1]).toMatch(/# MyNonDefaultName/);
      expect(writeSpy.mock.calls[1][0]).toMatch(/.*ig\.ini/);
      expect(writeSpy.mock.calls[1][1]).toMatch(/foo.bar/);
      expect(writeSpy.mock.calls[2][0]).toMatch(/.*sushi-config\.yaml/);
      expect(writeSpy.mock.calls[2][1].replace(/[\n\r]/g, '')).toBe(
        fs
          .readFileSync(
            path.join(__dirname, 'fixtures', 'init-config', 'user-input-config.yaml'),
            'utf-8'
          )
          .replace(/[\n\r]/g, '')
          .replace('${YEAR}', String(new Date().getFullYear()))
      );
      expect(copyFileSpy.mock.calls).toHaveLength(3);
      expect(copyFileSpy.mock.calls[0][1]).toMatch(/.*MyNonDefaultName.*fsh.*patient.fsh/);
      expect(copyFileSpy.mock.calls[1][1]).toMatch(/.*MyNonDefaultName.*\.gitignore/);
      expect(copyFileSpy.mock.calls[2][1]).toMatch(
        /.*MyNonDefaultName.*input.*ignoreWarnings\.txt/
      );

      expect(getSpy.mock.calls).toHaveLength(4);
      const base = 'https://raw.githubusercontent.com/HL7/ig-publisher-scripts/main/';
      expect(getSpy.mock.calls[0][0]).toBe(base + '_genonce.bat');
      expect(getSpy.mock.calls[1][0]).toBe(base + '_genonce.sh');
      expect(getSpy.mock.calls[2][0]).toBe(base + '_updatePublisher.bat');
      expect(getSpy.mock.calls[3][0]).toBe(base + '_updatePublisher.sh');

      expect(writeSpy.mock.calls[3][0]).toMatch(/.*_genonce\.bat/);
      expect(writeSpy.mock.calls[3][1]).toMatch(/_genonce\.bat/);
      expect(writeSpy.mock.calls[4][0]).toMatch(/.*_genonce\.sh/);
      expect(writeSpy.mock.calls[4][1]).toMatch(/_genonce\.sh/);
      expect(writeSpy.mock.calls[5][0]).toMatch(/.*_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[5][1]).toMatch(/_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[6][0]).toMatch(/.*_updatePublisher\.sh/);
      expect(writeSpy.mock.calls[6][1]).toMatch(/_updatePublisher\.sh/);
    });

    it('should abort initializing a project when the user does not confirm', async () => {
      yesNoSpy.mockImplementation(() => false);

      await init();
      expect(readlineSpy.mock.calls).toEqual([
        ['Name (Default: ExampleIG): '],
        ['Id (Default: fhir.example): '],
        ['Canonical (Default: http://example.org): '],
        ['Status (Default: draft): '],
        ['Version (Default: 0.1.0): '],
        ['Release Label (Default: ci-build): '],
        ['Publisher Name (Default: Example Publisher): '],
        ['Publisher Url (Default: http://example.org/example-publisher): ']
      ]);
      expect(yesNoSpy.mock.calls).toHaveLength(1);
      expect(yesNoSpy.mock.calls[0][0]).toMatch(/Initialize SUSHI project in .*ExampleIG/);
      expect(ensureDirSpy.mock.calls).toHaveLength(0);
      expect(writeSpy.mock.calls).toHaveLength(0);
      expect(copyFileSpy.mock.calls).toHaveLength(0);
      expect(consoleSpy.mock.calls.slice(-1)[0]).toEqual(['\nAborting Initialization.\n']);
    });

    it('should initialize a project when the user provides all config options on the command line and allows auto-initializing', async () => {
      await init('MyCLIOptionProject', {
        config: {
          id: 'foo.bar.baz',
          canonical: 'http://foo.bar.baz.com',
          status: 'active',
          version: '2.0.0',
          releaselabel: 'ballot',
          'publisher-name': 'Foo Bar Baz Inc.',
          'publisher-url': 'http://foo.org'
        },
        autoInitialize: true
      });
      expect(readlineSpy.mock.calls).toHaveLength(0);
      expect(yesNoSpy.mock.calls).toHaveLength(0);

      expect(ensureDirSpy.mock.calls).toHaveLength(2);
      expect(ensureDirSpy.mock.calls[0][0]).toMatch(/.*MyCLIOptionProject.*input.*pagecontent/);
      expect(ensureDirSpy.mock.calls[1][0]).toMatch(/.*MyCLIOptionProject.*input.*fsh/);

      expect(writeSpy.mock.calls).toHaveLength(7);
      expect(writeSpy.mock.calls[0][0]).toMatch(/.*index\.md/);
      expect(writeSpy.mock.calls[0][1]).toMatch(/# MyCLIOptionProject/);
      expect(writeSpy.mock.calls[1][0]).toMatch(/.*ig\.ini/);
      expect(writeSpy.mock.calls[1][1]).toMatch(/foo\.bar\.baz/);
      expect(writeSpy.mock.calls[2][0]).toMatch(/.*sushi-config\.yaml/);
      expect(writeSpy.mock.calls[2][1].replace(/[\n\r]/g, '')).toBe(
        fs
          .readFileSync(
            path.join(__dirname, 'fixtures', 'init-config', 'cli-input-config.yaml'),
            'utf-8'
          )
          .replace(/[\n\r]/g, '')
          .replace('${YEAR}', String(new Date().getFullYear()))
      );

      expect(copyFileSpy.mock.calls).toHaveLength(3);
      expect(copyFileSpy.mock.calls[0][1]).toMatch(/.*MyCLIOptionProject.*fsh.*patient.fsh/);
      expect(copyFileSpy.mock.calls[1][1]).toMatch(/.*MyCLIOptionProject.*\.gitignore/);
      expect(copyFileSpy.mock.calls[2][1]).toMatch(
        /.*MyCLIOptionProject.*input.*ignoreWarnings\.txt/
      );

      expect(getSpy.mock.calls).toHaveLength(4);
      const base = 'https://raw.githubusercontent.com/HL7/ig-publisher-scripts/main/';
      expect(getSpy.mock.calls[0][0]).toBe(base + '_genonce.bat');
      expect(getSpy.mock.calls[1][0]).toBe(base + '_genonce.sh');
      expect(getSpy.mock.calls[2][0]).toBe(base + '_updatePublisher.bat');
      expect(getSpy.mock.calls[3][0]).toBe(base + '_updatePublisher.sh');

      expect(writeSpy.mock.calls[3][0]).toMatch(/.*_genonce\.bat/);
      expect(writeSpy.mock.calls[3][1]).toMatch(/_genonce\.bat/);
      expect(writeSpy.mock.calls[4][0]).toMatch(/.*_genonce\.sh/);
      expect(writeSpy.mock.calls[4][1]).toMatch(/_genonce\.sh/);
      expect(writeSpy.mock.calls[5][0]).toMatch(/.*_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[5][1]).toMatch(/_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[6][0]).toMatch(/.*_updatePublisher\.sh/);
      expect(writeSpy.mock.calls[6][1]).toMatch(/_updatePublisher\.sh/);
    });

    it('should prompt for and accept inputs for any option not already set with a command line config option', async () => {
      readlineSpy.mockImplementation((question: string) => {
        if (question.startsWith('Status')) {
          return 'active';
        } else if (question.startsWith('Version')) {
          return '2.0.0';
        } else if (question.startsWith('Release Label')) {
          return 'trial-use';
        } else if (question.startsWith('Publisher Name')) {
          return 'Foo Two';
        }
      });

      await init('MySemiCLIOptionProject', {
        config: {
          id: 'foo.bar.baz',
          canonical: 'http://foo.bar.baz.com',
          // status, version, releaseLabel, publisherName all not specified so will need prompts
          'publisher-url': 'http://foo.org'
        }
        // autoInitialize not used so need to prompt to initialize
      });
      // Only prompt for the fields not specified in CLI options
      expect(readlineSpy.mock.calls).toEqual([
        ['Status (Default: draft): '],
        ['Version (Default: 0.1.0): '],
        ['Release Label (Default: ci-build): '],
        ['Publisher Name (Default: Example Publisher): ']
      ]);
      // Need to confirm initialization
      expect(yesNoSpy.mock.calls).toHaveLength(1);
      expect(yesNoSpy.mock.calls[0][0]).toMatch(
        /Initialize SUSHI project in .*MySemiCLIOptionProject/
      );

      expect(ensureDirSpy.mock.calls).toHaveLength(2);
      expect(ensureDirSpy.mock.calls[0][0]).toMatch(/.*MySemiCLIOptionProject.*input.*pagecontent/);
      expect(ensureDirSpy.mock.calls[1][0]).toMatch(/.*MySemiCLIOptionProject.*input.*fsh/);

      expect(writeSpy.mock.calls).toHaveLength(7);
      expect(writeSpy.mock.calls[0][0]).toMatch(/.*index\.md/);
      expect(writeSpy.mock.calls[0][1]).toMatch(/# MySemiCLIOptionProject/);
      expect(writeSpy.mock.calls[1][0]).toMatch(/.*ig\.ini/);
      expect(writeSpy.mock.calls[1][1]).toMatch(/foo\.bar\.baz/);
      expect(writeSpy.mock.calls[2][0]).toMatch(/.*sushi-config\.yaml/);
      expect(writeSpy.mock.calls[2][1].replace(/[\n\r]/g, '')).toBe(
        fs
          .readFileSync(
            path.join(__dirname, 'fixtures', 'init-config', 'semi-cli-input-config.yaml'),
            'utf-8'
          )
          .replace(/[\n\r]/g, '')
          .replace('${YEAR}', String(new Date().getFullYear()))
      );

      expect(copyFileSpy.mock.calls).toHaveLength(3);
      expect(copyFileSpy.mock.calls[0][1]).toMatch(/.*MySemiCLIOptionProject.*fsh.*patient.fsh/);
      expect(copyFileSpy.mock.calls[1][1]).toMatch(/.*MySemiCLIOptionProject.*\.gitignore/);
      expect(copyFileSpy.mock.calls[2][1]).toMatch(
        /.*MySemiCLIOptionProject.*input.*ignoreWarnings\.txt/
      );

      expect(getSpy.mock.calls).toHaveLength(4);
      const base = 'https://raw.githubusercontent.com/HL7/ig-publisher-scripts/main/';
      expect(getSpy.mock.calls[0][0]).toBe(base + '_genonce.bat');
      expect(getSpy.mock.calls[1][0]).toBe(base + '_genonce.sh');
      expect(getSpy.mock.calls[2][0]).toBe(base + '_updatePublisher.bat');
      expect(getSpy.mock.calls[3][0]).toBe(base + '_updatePublisher.sh');

      expect(writeSpy.mock.calls[3][0]).toMatch(/.*_genonce\.bat/);
      expect(writeSpy.mock.calls[3][1]).toMatch(/_genonce\.bat/);
      expect(writeSpy.mock.calls[4][0]).toMatch(/.*_genonce\.sh/);
      expect(writeSpy.mock.calls[4][1]).toMatch(/_genonce\.sh/);
      expect(writeSpy.mock.calls[5][0]).toMatch(/.*_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[5][1]).toMatch(/_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[6][0]).toMatch(/.*_updatePublisher\.sh/);
      expect(writeSpy.mock.calls[6][1]).toMatch(/_updatePublisher\.sh/);
    });

    it('should accept remaining defaults without prompting for any options not already set with a command line config option when default option is used', async () => {
      await init('MyCLIOptionWithDefaultsProject', {
        config: {
          id: 'foo.bar.baz',
          canonical: 'http://foo.bar.baz.com',
          // status, version, releaseLabel, publisherName all not specified so will use defaults
          'publisher-url': 'http://foo.org'
        },
        default: true, // use defaults for any unspecified fields
        autoInitialize: true
      });

      expect(readlineSpy.mock.calls).toHaveLength(0);
      expect(yesNoSpy.mock.calls).toHaveLength(0);

      expect(ensureDirSpy.mock.calls).toHaveLength(2);
      expect(ensureDirSpy.mock.calls[0][0]).toMatch(
        /.*MyCLIOptionWithDefaultsProject.*input.*pagecontent/
      );
      expect(ensureDirSpy.mock.calls[1][0]).toMatch(/.*MyCLIOptionWithDefaultsProject.*input.*fsh/);

      expect(writeSpy.mock.calls).toHaveLength(7);
      expect(writeSpy.mock.calls[0][0]).toMatch(/.*index\.md/);
      expect(writeSpy.mock.calls[0][1]).toMatch(/# MyCLIOptionWithDefaultsProject/);
      expect(writeSpy.mock.calls[1][0]).toMatch(/.*ig\.ini/);
      expect(writeSpy.mock.calls[1][1]).toMatch(/foo\.bar\.baz/);
      expect(writeSpy.mock.calls[2][0]).toMatch(/.*sushi-config\.yaml/);
      expect(writeSpy.mock.calls[2][1].replace(/[\n\r]/g, '')).toBe(
        fs
          .readFileSync(
            path.join(__dirname, 'fixtures', 'init-config', 'cli-input-with-defaults-config.yaml'),
            'utf-8'
          )
          .replace(/[\n\r]/g, '')
          .replace('${YEAR}', String(new Date().getFullYear()))
      );

      expect(copyFileSpy.mock.calls).toHaveLength(3);
      expect(copyFileSpy.mock.calls[0][1]).toMatch(
        /.*MyCLIOptionWithDefaultsProject.*fsh.*patient.fsh/
      );
      expect(copyFileSpy.mock.calls[1][1]).toMatch(/.*MyCLIOptionWithDefaultsProject.*\.gitignore/);
      expect(copyFileSpy.mock.calls[2][1]).toMatch(
        /.*MyCLIOptionWithDefaultsProject.*input.*ignoreWarnings\.txt/
      );

      expect(getSpy.mock.calls).toHaveLength(4);
      const base = 'https://raw.githubusercontent.com/HL7/ig-publisher-scripts/main/';
      expect(getSpy.mock.calls[0][0]).toBe(base + '_genonce.bat');
      expect(getSpy.mock.calls[1][0]).toBe(base + '_genonce.sh');
      expect(getSpy.mock.calls[2][0]).toBe(base + '_updatePublisher.bat');
      expect(getSpy.mock.calls[3][0]).toBe(base + '_updatePublisher.sh');

      expect(writeSpy.mock.calls[3][0]).toMatch(/.*_genonce\.bat/);
      expect(writeSpy.mock.calls[3][1]).toMatch(/_genonce\.bat/);
      expect(writeSpy.mock.calls[4][0]).toMatch(/.*_genonce\.sh/);
      expect(writeSpy.mock.calls[4][1]).toMatch(/_genonce\.sh/);
      expect(writeSpy.mock.calls[5][0]).toMatch(/.*_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[5][1]).toMatch(/_updatePublisher\.bat/);
      expect(writeSpy.mock.calls[6][0]).toMatch(/.*_updatePublisher\.sh/);
      expect(writeSpy.mock.calls[6][1]).toMatch(/_updatePublisher\.sh/);
    });
  });

  describe('#getLatestSushiVersion()', () => {
    let mockedChildProcess: jest.Mocked<typeof child_process>;
    let mockedAxios: jest.Mocked<typeof axios>;

    beforeAll(() => {
      jest.mock('child_process');
      mockedChildProcess = child_process as jest.Mocked<typeof child_process>;
      mockedChildProcess.execSync = jest.fn();

      jest.mock('axios');
      mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.get = jest.fn();
    });

    beforeEach(() => {
      loggerSpy.reset();
    });

    it('successfully fetches data', async () => {
      // prettier-ignore
      mockedChildProcess.execSync.mockImplementationOnce(() => Buffer.from("2.2.6\n")); // eslint-disable-line quotes
      await expect(getLatestSushiVersion()).resolves.toEqual('2.2.6');

      mockedChildProcess.execSync.mockImplementationOnce(() => Buffer.from('2.2.6'));
      await expect(getLatestSushiVersion()).resolves.toEqual('2.2.6');
    });

    it('falls back to URL if primary process fails', async () => {
      mockedChildProcess.execSync.mockImplementationOnce(() => Buffer.from('npm ERR! code E404'));

      const data = {
        data: {
          name: 'fsh-sushi',
          'dist-tags': {
            latest: '2.1.6',
            beta: '2.0.0-beta.3',
            'pre-1.0': '0.16.1',
            internal: '2.0.0-beta.1-fshonline-hotfix'
          }
        }
      };
      mockedAxios.get.mockImplementationOnce(() => Promise.resolve(data));

      await expect(getLatestSushiVersion()).resolves.toEqual('2.1.6');
    });

    it("unsuccessfully fetches data if it doesn't look like a semver is not found", async () => {
      mockedChildProcess.execSync.mockImplementationOnce(() => Buffer.from('npm ERR! code E404'));
      const data = {};
      mockedAxios.get.mockImplementationOnce(() => Promise.resolve(data));

      const version = await getLatestSushiVersion();
      expect(version).toBeUndefined();
      // Loosely match message since it differs slightly between npm 6 and npm 8
      expect(loggerSpy.getLastMessage('warn')).toMatch(
        /Unable to determine the latest version of sushi: Cannot read .*'dist-tags'.*/
      );
    });
  });

  describe('#checkSushiVersion()', () => {
    let mockedChildProcess: jest.Mocked<typeof child_process>;

    beforeAll(() => {
      jest.mock('child_process');
      mockedChildProcess = child_process as jest.Mocked<typeof child_process>;
      mockedChildProcess.execSync = jest.fn();
    });

    it('returns an object with the latest and current sushi versions', async () => {
      const localVersion = getLocalSushiVersion();
      const latestVersion = '2.5.0'; // A fake stable version (not a prerelease, like beta)

      mockedChildProcess.execSync.mockImplementationOnce(() => Buffer.from(`${latestVersion}\n`));
      const versionObj = await checkSushiVersion();
      expect(versionObj).toHaveProperty('latest');
      expect(versionObj).toHaveProperty('current');
      expect(versionObj).toStrictEqual({ latest: latestVersion, current: localVersion });
    });

    it('should return an object with an undefined latest value when latest is not present', async () => {
      const localVersion = getLocalSushiVersion();

      // prettier-ignore
      mockedChildProcess.execSync.mockImplementationOnce(() =>
        Buffer.from("zsh: command not found: npm\n") // eslint-disable-line quotes
      );
      const versionObj = await checkSushiVersion();
      expect(versionObj).toHaveProperty('latest');
      expect(versionObj).toHaveProperty('current');
      expect(versionObj).toStrictEqual({ latest: undefined, current: localVersion });
    });
  });
});
