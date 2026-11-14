import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'chai';

const APPS = path.resolve(__dirname, '../../../../apps');

/**
 * Prisma Client ที่ generate ด้วย output ค่าตั้งต้นของทุก Service ไปอยู่ที่ node_modules/.prisma/client เดียวกัน
 * (Service หนึ่งเขียนทับอีก Service) ดังนั้น Service ที่มี Prisma ต้องมี `output` ของตัวเอง และไม่ซ้ำกัน
 * (ปล่อยให้ใช้ค่าตั้งต้นได้อย่างมากหนึ่ง Service) — กฎใน docs/developer-guide.md §4 ข้อ 9
 */
function generatorOutputs(): Array<{ app: string; output: string | null }> {
  return readdirSync(APPS)
    .map((app) => ({ app, schema: path.join(APPS, app, 'prisma', 'schema.prisma') }))
    .filter(({ schema }) => existsSync(schema))
    .map(({ app, schema }) => {
      const text = readFileSync(schema, 'utf8');
      const block = /generator\s+client\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
      const output = /^\s*output\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? null;
      return { app, output };
    });
}

describe('Prisma generator output ของแต่ละ Service (กัน Client ชนกันใน CI/ในเครื่อง)', () => {
  it('พบ Service ที่มี prisma/schema.prisma อย่างน้อย verification และ identity', () => {
    const apps = generatorOutputs().map((g) => g.app);
    expect(apps).to.include.members(['verification', 'identity']);
  });

  it('ใช้ output ค่าตั้งต้นได้อย่างมากหนึ่ง Service', () => {
    const defaults = generatorOutputs().filter((g) => g.output === null).map((g) => g.app);
    expect(defaults, `ใช้ค่าตั้งต้นพร้อมกัน: ${defaults.join(', ')} — ต้องตั้ง output = "../generated/client"`).to.have.length.lessThan(2);
  });

  it('output ที่ตั้งเองต้องไม่ซ้ำกัน และอยู่ภายใต้ apps/<service>/generated/', () => {
    const own = generatorOutputs()
      .filter((g) => g.output !== null)
      .map((g) => ({ ...g, resolved: path.resolve(APPS, g.app, 'prisma', g.output!) }));
    for (const g of own) {
      expect(g.resolved.startsWith(path.join(APPS, g.app, 'generated')), `${g.app}: ${g.output}`).to.equal(true);
    }
    expect(new Set(own.map((g) => g.resolved)).size).to.equal(own.length);
  });
});
