import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'chai';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

/** enum ทุกตัวใน libs/contracts/src/enums.ts ต้องตรงกับตาราง data-schema.md §2.1 (ที่เก็บหลัก) ทั้งชื่อและค่า */
function docEnums(): Map<string, string[]> {
  const doc = read('docs/data-schema.md');
  const start = doc.indexOf('### 2.1 Enum สถานะ');
  const end = doc.indexOf('### 2.2', start);
  const rows = new Map<string, string[]>();
  for (const line of doc.slice(start, end).split('\n')) {
    const m = /^\|\s*`(\w+)`\s*\|\s*(.+?)\s*\|\s*\w+\s*\|\s*$/.exec(line);
    if (!m) continue;
    const withoutNotes = m[2].replace(/\([^)]*\)/g, ''); // ตัดหมายเหตุในวงเล็บ (มี `ค่า` ปนอยู่)
    rows.set(m[1], [...withoutNotes.matchAll(/`([A-Z0-9_]+)`/g)].map((x) => x[1]));
  }
  return rows;
}

function codeEnums(): Map<string, string[]> {
  const src = read('libs/contracts/src/enums.ts');
  const types = new Map<string, string[]>();
  for (const m of src.matchAll(/export type (\w+)\s*=\s*([^;]+);/g)) {
    types.set(m[1], [...m[2].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]));
  }
  return types;
}

describe('libs/contracts enums เทียบกับ docs/data-schema.md §2.1', () => {
  const docs = docEnums();
  const code = codeEnums();

  it('พบ enum ในเอกสารอย่างน้อย 15 ตัว (parser ทำงาน)', () => {
    expect(docs.size).to.be.greaterThan(14);
  });

  it('ทุก enum ในเอกสารมีชนิดชื่อเดียวกันใน enums.ts และชุดค่าตรงกันทุกตัว', () => {
    const problems: string[] = [];
    for (const [name, values] of docs) {
      const ts = code.get(name);
      if (!ts) problems.push(`${name}: ไม่มีใน enums.ts`);
      else if ([...values].sort().join(',') !== [...ts].sort().join(',')) {
        problems.push(`${name}: เอกสาร [${values.join(', ')}] ≠ โค้ด [${ts.join(', ')}]`);
      }
    }
    expect(problems, problems.join('\n')).to.deep.equal([]);
  });

  it('enums.ts ไม่มี enum ที่เอกสารไม่รู้จัก', () => {
    const extra = [...code.keys()].filter((n) => !docs.has(n));
    expect(extra).to.deep.equal([]);
  });
});
