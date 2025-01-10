import { assertAssignmentRule, assertInsertRule, assertPathRule } from '../testhelpers/asserts';
import { FshCode } from '../../src/fshtypes';
import { loggerSpy } from '../testhelpers/loggerSpy';
import { importSingleText } from '../testhelpers/importSingleText';
import { importText, RawFSH } from '../../src/import';

describe('FSHImporter', () => {
  beforeEach(() => {
    loggerSpy.reset();
  });

  describe('Instance', () => {
    describe('#instanceOf', () => {
      it('should parse the simplest possible instance', () => {
        const input = `
        Instance: MyObservation
        InstanceOf: Observation
        `;

        const result = importSingleText(input, 'SimpleInstance.fsh');
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyObservation');
        expect(instance.name).toBe('MyObservation');
        expect(instance.instanceOf).toBe('Observation');
        expect(instance.title).toBeUndefined();
        expect(instance.description).toBeUndefined();
        expect(instance.rules.length).toBe(0);
        expect(instance.sourceInfo.location).toEqual({
          startLine: 2,
          startColumn: 9,
          endLine: 3,
          endColumn: 31
        });
        expect(instance.sourceInfo.file).toBe('SimpleInstance.fsh');
      });

      it('should parse numeric instance name and numeric instanceOf', () => {
        // NOT recommended, but possible
        const input = `
        Instance: 123
        InstanceOf: 456
        `;

        const result = importSingleText(input, 'SimpleInstance.fsh');
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('123');
        expect(instance.name).toBe('123');
        expect(instance.instanceOf).toBe('456');
      });

      it('should parse an instance with an aliased type', () => {
        const input = `
        Alias: obs = Observation
        Instance: MyObservation
        InstanceOf: obs
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyObservation');
        expect(instance.instanceOf).toBe('Observation');
      });

      it('should not parse an instance that has no type', () => {
        const input = `
        Instance: MyObservation
        Title: "My Important Observation"
        `;

        const result = importSingleText(input, 'Missing.fsh');
        expect(result.instances.size).toBe(0);
        expect(loggerSpy.getLastMessage('error')).toMatch(/File: Missing\.fsh.*Line: 2 - 3\D*/s);
      });
    });

    describe('#title', () => {
      it('should parse an instance with a title', () => {
        const input = `
        Instance: MyObservation
        InstanceOf: Observation
        Title: "My Important Observation"
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyObservation');
        expect(instance.name).toBe('MyObservation');
        expect(instance.instanceOf).toBe('Observation');
        expect(instance.title).toBe('My Important Observation');
      });
    });

    describe('#description', () => {
      it('should parse an instance with a description', () => {
        const input = `
        Instance: MyObservation
        InstanceOf: Observation
        Description: "Shows an example of an Observation"
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyObservation');
        expect(instance.name).toBe('MyObservation');
        expect(instance.instanceOf).toBe('Observation');
        expect(instance.description).toBe('Shows an example of an Observation');
      });
    });

    describe('#usage', () => {
      it('should parse an instance with a usage', () => {
        const input = `
        Instance: MyObservation
        InstanceOf: Observation
        Usage: #example
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyObservation');
        expect(instance.name).toBe('MyObservation');
        expect(instance.instanceOf).toBe('Observation');
        expect(instance.usage).toBe('Example');
      });

      it('should log an error for invalid usage and set default usage to example', () => {
        const input = `
        Instance: MyBadObservation
        InstanceOf: Observation
        Usage: #baduse
        `;

        const result = importSingleText(input, 'Bad.fsh');
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyBadObservation');
        expect(instance.name).toBe('MyBadObservation');
        expect(instance.instanceOf).toBe('Observation');
        expect(instance.usage).toBe('Example');
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /Invalid Usage. Supported usage codes are "#example", "#definition", and "#inline". Instance will be treated as an example./s
        );
        expect(loggerSpy.getLastMessage('error')).toMatch(/File: Bad\.fsh.*Line: 4\D*/s);
      });

      it('should log a warning if a system is specified on usage', () => {
        const input = `
        Instance: MyBadObservation
        InstanceOf: Observation
        Usage: badsystem#example
        `;

        const result = importSingleText(input, 'Bad.fsh');
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyBadObservation');
        expect(instance.name).toBe('MyBadObservation');
        expect(instance.instanceOf).toBe('Observation');
        expect(instance.usage).toBe('Example');
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /Do not specify a system for instance Usage./s
        );
        expect(loggerSpy.getLastMessage('warn')).toMatch(/File: Bad\.fsh.*Line: 4\D*/s);
      });

      it('should log a warning if a conformance or terminology resource does not have a usage (and therefore will default to example)', () => {
        // No usage specified for a CapabilityStatement instance
        const input = `
        Instance: MyCapabilityStatementDefinition
        InstanceOf: CapabilityStatement
        `;

        const result = importSingleText(input, 'CS.fsh');
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyCapabilityStatementDefinition');
        expect(instance.name).toBe('MyCapabilityStatementDefinition');
        expect(instance.instanceOf).toBe('CapabilityStatement');
        expect(instance.usage).toBe('Example'); // default is still used but warning is logged
        expect(loggerSpy.getAllMessages('error')).toHaveLength(0);
        expect(loggerSpy.getAllMessages('warn')).toHaveLength(1);
        expect(loggerSpy.getLastMessage('warn')).toMatch(
          /No usage was specified on MyCapabilityStatementDefinition\. The default #example usage will be applied, but CapabilityStatement Instances are typically definitions/s
        );
        expect(loggerSpy.getLastMessage('warn')).toMatch(/File: CS\.fsh.*Line: 2 - 3\D*/s);
      });
    });

    describe('#mixins', () => {
      it('should log an error when the deprecated Mixins keyword is used', () => {
        const input = `
        Instance: MyObservation
        InstanceOf: Observation
        Mixins: RuleSet1 and RuleSet2
        `;

        const result = importSingleText(input, 'Deprecated.fsh');
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyObservation');
        expect(instance.name).toBe('MyObservation');
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /The 'Mixins' keyword is no longer supported\./s
        );
        expect(loggerSpy.getLastMessage('error')).toMatch(/File: Deprecated\.fsh.*Line: 4\D*/s);
      });
    });

    describe('#assignmentRule', () => {
      it('should parse an instance with assigned value rules', () => {
        const input = `
        Instance: SamplePatient
        InstanceOf: Patient
        Title: "Georgio Manos"
        Description: "An example of a fictional patient named Georgio Manos"
        Usage: #example
        * name[0].family = "Georgio"
        * name[0].given[0] = "Manos"
        * gender = #other
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('SamplePatient');
        expect(instance.instanceOf).toBe('Patient');
        expect(instance.title).toBe('Georgio Manos');
        expect(instance.description).toBe('An example of a fictional patient named Georgio Manos');
        expect(instance.usage).toBe('Example');
        expect(instance.rules.length).toBe(3);
        assertAssignmentRule(instance.rules[0], 'name[0].family', 'Georgio');
        assertAssignmentRule(instance.rules[1], 'name[0].given[0]', 'Manos');
        assertAssignmentRule(
          instance.rules[2],
          'gender',
          new FshCode('other').withLocation([9, 20, 9, 25]).withFile('')
        );
      });

      it('should parse an instance with assigned values that are an alias', () => {
        const input = `
        Alias: EXAMPLE = http://example.org

        Instance: PatientExample
        InstanceOf: Patient
        * identifier[0].system = EXAMPLE
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('PatientExample');
        expect(instance.rules).toHaveLength(1);
        expect(instance.instanceOf).toBe('Patient');
        assertAssignmentRule(instance.rules[0], 'identifier[0].system', 'http://example.org');
      });

      it('should parse an instance with assigned value resource rules', () => {
        const input = `
        Instance: SamplePatient
        InstanceOf: Patient
        Title: "Georgio Manos"
        Description: "An example of a fictional patient named Georgio Manos"
        * contained[0] = SomeInstance
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('SamplePatient');
        expect(instance.instanceOf).toBe('Patient');
        expect(instance.title).toBe('Georgio Manos');
        expect(instance.description).toBe('An example of a fictional patient named Georgio Manos');
        expect(instance.rules.length).toBe(1);
        assertAssignmentRule(instance.rules[0], 'contained[0]', 'SomeInstance', false, true);
      });
    });

    describe('#pathRule', () => {
      it('should parse a pathRule', () => {
        const input = `
        Instance: PatientProfile
        InstanceOf: Patient
        * name
        `;
        const result = importSingleText(input, 'Path.fsh');
        const instance = result.instances.get('PatientProfile');
        expect(instance.rules).toHaveLength(1);
        assertPathRule(instance.rules[0], 'name');
      });
    });

    describe('#insertRule', () => {
      it('should parse an insert rule with a single RuleSet', () => {
        const input = `
        Instance: MyPatient
        InstanceOf: Patient
        * insert MyRuleSet
        `;
        const result = importSingleText(input, 'Insert.fsh');
        const instance = result.instances.get('MyPatient');
        expect(instance.rules).toHaveLength(1);
        assertInsertRule(instance.rules[0], '', 'MyRuleSet');
      });

      it('should parse an insert rule with an empty parameter value', () => {
        // Example taken from open-hie/case-reporting, which failed a regression in this area
        const input = `
        RuleSet: Question(context, linkId, text, type, repeats)
        * {context}item[+].linkId = "{linkId}"
        * {context}item[=].text = "{text}"
        * {context}item[=].type = #{type}
        * {context}item[=].repeats = {repeats}

        Instance: case-reporting-questionnaire
        InstanceOf: Questionnaire
        * insert Question(,title, HIV Case Report, display, false)
        `;
        const result = importSingleText(input, 'Insert.fsh');
        const instance = result.instances.get('case-reporting-questionnaire');
        expect(instance.rules).toHaveLength(1);
        assertInsertRule(instance.rules[0], '', 'Question', [
          '',
          'title',
          'HIV Case Report',
          'display',
          'false'
        ]);
      });
    });

    describe('#instanceMetadata', () => {
      it('should only apply each metadata attribute the first time it is declared', () => {
        const input = `
        Instance: MyObservation
        InstanceOf: Observation
        Title: "My Important Observation"
        Description: "My Observation Description"
        Usage: #example
        InstanceOf: DuplicateObservation
        Title: "My Duplicate Observation"
        Description: "My Duplicate Observation Description"
        Usage: #non-example
        `;

        const result = importSingleText(input);
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyObservation');
        expect(instance.name).toBe('MyObservation');
        expect(instance.instanceOf).toBe('Observation');
        expect(instance.title).toBe('My Important Observation');
        expect(instance.description).toBe('My Observation Description');
        expect(instance.usage).toBe('Example');
      });

      it('should log an error when encountering a duplicate metadata attribute', () => {
        const input = `
        Instance: MyObservation
        InstanceOf: Observation
        Title: "My Important Observation"
        Description: "My Observation Description"
        Usage: #example
        InstanceOf: DuplicateObservation
        Title: "My Duplicate Observation"
        Description: "My Duplicate Observation Description"
        Usage: #non-example
        `;

        importSingleText(input, 'Dupe.fsh');
        expect(loggerSpy.getMessageAtIndex(-4, 'error')).toMatch(/File: Dupe\.fsh.*Line: 7\D*/s);
        expect(loggerSpy.getMessageAtIndex(-3, 'error')).toMatch(/File: Dupe\.fsh.*Line: 8\D*/s);
        expect(loggerSpy.getMessageAtIndex(-2, 'error')).toMatch(/File: Dupe\.fsh.*Line: 9\D*/s);
        expect(loggerSpy.getLastMessage('error')).toMatch(/File: Dupe\.fsh.*Line: 10\D*/s);
      });

      it('should log an error and skip the instance when encountering an instance with a name used by another instance', () => {
        const input = `
        Instance: MyInstance
        InstanceOf: Observation

        Instance: MyInstance
        InstanceOf: Patient
        `;

        const result = importSingleText(input, 'SameName.fsh');
        expect(result.instances.size).toBe(1);
        const instance = result.instances.get('MyInstance');
        expect(instance.instanceOf).toBe('Observation');
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /Instance named MyInstance already exists/s
        );
        expect(loggerSpy.getLastMessage('error')).toMatch(/File: SameName\.fsh.*Line: 5 - 6\D*/s);
      });

      it('should log an error and skip the instance when encountering an instance with a name used by another instance in another file', () => {
        const input1 = `
          Instance: SomeInstance
          InstanceOf: Patient
          Title: "Instance 1"
        `;

        const input2 = `
          Instance: SomeInstance
          InstanceOf: Patient
          Title: "Instance 2"
        `;

        const result = importText([
          new RawFSH(input1, 'File1.fsh'),
          new RawFSH(input2, 'File2.fsh')
        ]);
        expect(result.reduce((sum, d2) => sum + d2.instances.size, 0)).toBe(1);
        const instance = result[0].instances.get('SomeInstance');
        expect(instance.title).toBe('Instance 1');
        expect(loggerSpy.getLastMessage('error')).toMatch(
          /Instance named SomeInstance already exists/s
        );
        expect(loggerSpy.getLastMessage('error')).toMatch(/File: File2\.fsh.*Line: 2 - 4\D*/s);
      });

      it('should not produce an error when encountering an instance with a name used by another instance in another file but has a unique versionId', () => {
        const input1 = `
          Instance: SomeInstance
          InstanceOf: Patient
          Title: "Instance"
          * meta
          * meta.versionId = "1"
        `;

        const input2 = `
          Instance: SomeInstance
          InstanceOf: Patient
          Title: "Instance"
          * meta
          * meta.versionId = "2"
        `;

        const input3 = `
          Instance: SomeInstance
          InstanceOf: Patient
          Title: "Instance"
        `;

        const result = importText([
          new RawFSH(input1, 'File1.fsh'),
          new RawFSH(input2, 'File2.fsh'),
          new RawFSH(input3, 'File2.fsh')
        ]);
        expect(result.reduce((sum, d2) => sum + d2.instances.size, 0)).toBe(3);
        const instance1 = result[0].instances.get('SomeInstance');
        const instance2 = result[1].instances.get('SomeInstance');
        const instance3 = result[2].instances.get('SomeInstance');
        expect(instance1.title).toBe('Instance');
        expect(instance1.versionId).toBe('1');
        expect(instance1.title).toBe('Instance');
        expect(instance2.versionId).toBe('2');
        expect(instance3.title).toBe('Instance');
        expect(instance3.versionId).toBe(undefined);
      });
    });
  });
});
