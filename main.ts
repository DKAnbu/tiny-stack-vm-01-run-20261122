// Tiny stack VM (ISA v1) for make.fun tiny-stack-vm-01: runs each
// /input/<id>/program.bin on input.bin, writes /output/<id>/stdout.bin
// and exit.txt. 32-bit wrapping math, 256-value stack, 64-deep call
// stack, 256 words of memory, ten traps, step/output limits. Deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const IM = new Uint8Array(256); // immediate bytes per opcode
const ND = new Uint8Array(256); // values popped
const GV = new Uint8Array(256); // values pushed
const KN = new Uint8Array(256); // 1 when the byte is an opcode
const def = (o, i, n, g) => { IM[o] = i; ND[o] = n; GV[o] = g; KN[o] = 1; };
def(0, 0, 0, 0); def(1, 1, 0, 1); def(2, 4, 0, 1); def(3, 0, 1, 0);
def(4, 0, 1, 2); def(5, 0, 2, 2); def(6, 0, 2, 3); def(7, 0, 3, 3);
for (const o of [16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 28, 29, 30, 32, 33, 34]) def(o, 0, 2, 1);
def(23, 0, 1, 1); def(27, 0, 1, 1); // NEG, NOT
def(48, 2, 0, 0); def(49, 2, 1, 0); def(50, 2, 1, 0); // JMP, JZ, JNZ
def(51, 2, 0, 0); def(52, 0, 0, 0); // CALL, RET
def(64, 0, 1, 1); def(65, 0, 2, 0); // LOAD, STORE
def(80, 0, 1, 0); def(81, 0, 1, 0); def(82, 0, 0, 1); def(83, 0, 1, 0); // PRINT, PUTC, IN, EXIT

// Returns [exitCode, outputLength]; output bytes are in `out`.
function run(p, inp, out) {
  const n = p.length, st = new Int32Array(256), cs = new Int32Array(64), mem = new Int32Array(256);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  for (;;) {
    if (steps === 1000000) return [10, ol];
    if (pc < 0 || pc >= n) return [9, ol];
    const op = p[pc];
    if (!KN[op]) return [5, ol];
    const imm = IM[op];
    if (pc + imm >= n) return [9, ol];
    steps++;
    const nx = pc + 1 + imm;
    if (sp < ND[op]) return [2, ol];
    if (sp - ND[op] + GV[op] > 256) return [3, ol];
    pc = nx;
    switch (op) {
      case 0: return [0, ol];
      case 1: st[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8 sign-extended
      case 2: st[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break;
      case 3: sp--; break;
      case 4: st[sp] = st[sp - 1]; sp++; break;
      case 5: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; }
      case 6: st[sp] = st[sp - 2]; sp++; break;
      case 7: { const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; break; }
      case 23: st[sp - 1] = (-st[sp - 1]) | 0; break; // NEG wraps
      case 27: st[sp - 1] = ~st[sp - 1]; break;
      case 48: case 49: case 50: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = op === 48;
        if (!take) { const v = st[--sp]; take = op === 49 ? v === 0 : v !== 0; }
        if (take) pc = nx + rel;
        break;
      }
      case 51:
        if (cp === 64) return [7, ol];
        cs[cp++] = nx; pc = p[nx - 2] | (p[nx - 1] << 8); break;
      case 52:
        if (cp === 0) return [8, ol];
        pc = cs[--cp]; break;
      case 64: { const a = st[sp - 1]; if (a < 0 || a >= 256) return [6, ol]; st[sp - 1] = mem[a]; break; }
      case 65: {
        const a = st[sp - 1], v = st[sp - 2];
        if (a < 0 || a >= 256) return [6, ol];
        sp -= 2; mem[a] = v; break;
      }
      case 80: {
        const s = String(st[sp - 1]);
        if (ol + s.length > 65536) return [11, ol];
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 81:
        if (ol + 1 > 65536) return [11, ol];
        out[ol++] = st[--sp] & 255; break;
      case 82: st[sp++] = ip < inp.length ? inp[ip++] : -1; break;
      case 83: return [st[--sp] & 255, ol];
      default: { // binary ops: ( a b -- r ), b is the top
        const b = st[sp - 1], a = st[sp - 2];
        let r;
        if (op === 16) r = (a + b) | 0;
        else if (op === 17) r = (a - b) | 0;
        else if (op === 18) r = Math.imul(a, b);
        else if (op === 19) {
          if (b === 0) return [4, ol];
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 20) {
          if (b === 0) return [4, ol];
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 21) {
          if (b === 0) return [4, ol];
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 22) {
          if (b === 0) return [4, ol];
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 24) r = a & b;
        else if (op === 25) r = a | b;
        else if (op === 26) r = a ^ b;
        else if (op === 28) r = a << (b & 31);
        else if (op === 29) r = a >> (b & 31);
        else if (op === 30) r = (a >>> (b & 31)) | 0;
        else if (op === 32) r = a === b ? 1 : 0;
        else if (op === 33) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2; st[sp++] = r;
        break;
      }
    }
  }
}

const out = new Uint8Array(65536);
for (const id of readdirSync(I).sort()) {
  const dir = join(I, id);
  let prog;
  try { prog = readFileSync(join(dir, 'program.bin')); } catch { continue; }
  const inp = readFileSync(join(dir, 'input.bin'));
  const [code, len] = run(prog, inp, out);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), out.subarray(0, len));
  writeFileSync(join(O, id, 'exit.txt'), String(code) + '\n');
}
