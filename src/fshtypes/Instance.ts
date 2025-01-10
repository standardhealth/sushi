import { AssignmentRule, InsertRule, PathRule } from './rules';
import { FshEntity } from './FshEntity';
import { EOL } from 'os';
import { fshifyString, getNonInstanceValueFromRules } from './common';
import { InstanceUsage } from './InstanceUsage';

export class Instance extends FshEntity {
  private _id: string;
  title?: string;
  instanceOf: string;
  description?: string;
  usage?: InstanceUsage;
  versionId?: string;
  rules: (AssignmentRule | InsertRule | PathRule)[];

  constructor(public name: string) {
    super();
    this.id = name; // init same as name
    this.rules = [];
    this.usage = 'Example'; // init to Example (default)
    this.versionId = undefined; // init to undefined (default)
  }

  get constructorName() {
    return 'Instance';
  }

  get id() {
    const assignedId = getNonInstanceValueFromRules(this, 'id', '', 'id');
    if (typeof assignedId === 'string') {
      return assignedId;
    }
    return this._id;
  }

  set id(id: string) {
    this._id = id;
  }

  metadataToFSH() {
    const resultLines: string[] = [];
    resultLines.push(`Instance: ${this.name}`);
    resultLines.push(`InstanceOf: ${this.instanceOf}`);
    if (this.title) {
      resultLines.push(`Title: "${fshifyString(this.title)}"`);
    }
    if (this.description) {
      // Description can be a multiline string.
      // If it contains newline characters, treat it as a multiline string.
      if (this.description.indexOf('\n') > -1) {
        resultLines.push(`Description: """${this.description}"""`);
      } else {
        resultLines.push(`Description: "${fshifyString(this.description)}"`);
      }
    }
    if (this.usage) {
      resultLines.push(`Usage: #${this.usage.toLowerCase()}`);
    }
    return resultLines.join(EOL);
  }

  toFSH(): string {
    const metadataFSH = this.metadataToFSH();
    const rulesFSH = this.rules.map(r => r.toFSH()).join(EOL);
    return `${metadataFSH}${rulesFSH.length ? EOL + rulesFSH : ''}`;
  }
}
