/* globals expect, it, describe, beforeEach, isArray, StringStream,
           PostScriptParser, PostScriptLexer, PostScriptEvaluator,
           PostScriptCompiler*/

'use strict';

describe('function', () => {
  beforeEach(function () {
    this.addMatchers({
      toMatchArray(expected) {
        const actual = this.actual;
        if (actual.length !== expected.length) {
          return false;
        }
        for (let i = 0; i < expected.length; i++) {
          const a = actual[i]; const
            b = expected[i];
          if (isArray(b)) {
            if (a.length !== b.length) {
              return false;
            }
            for (let j = 0; j < a.length; j++) {
              const suba = a[j]; const
                subb = b[j];
              if (suba !== subb) {
                return false;
              }
            }
          } else if (a !== b) {
            return false;
          }
        }
        return true;
      },
    });
  });

  describe('PostScriptParser', () => {
    function parse(program) {
      const stream = new StringStream(program);
      const parser = new PostScriptParser(new PostScriptLexer(stream));
      return parser.parse();
    }
    it('parses empty programs', () => {
      const output = parse('{}');
      expect(output.length).toEqual(0);
    });
    it('parses positive numbers', () => {
      const number = 999;
      const program = parse(`{ ${number} }`);
      const expectedProgram = [number];
      expect(program).toMatchArray(expectedProgram);
    });
    it('parses negative numbers', () => {
      const number = -999;
      const program = parse(`{ ${number} }`);
      const expectedProgram = [number];
      expect(program).toMatchArray(expectedProgram);
    });
    it('parses negative floats', () => {
      const number = 3.3;
      const program = parse(`{ ${number} }`);
      const expectedProgram = [number];
      expect(program).toMatchArray(expectedProgram);
    });
    it('parses operators', () => {
      const program = parse('{ sub }');
      const expectedProgram = ['sub'];
      expect(program).toMatchArray(expectedProgram);
    });
    it('parses if statements', () => {
      const program = parse('{ { 99 } if }');
      const expectedProgram = [3, 'jz', 99];
      expect(program).toMatchArray(expectedProgram);
    });
    it('parses ifelse statements', () => {
      const program = parse('{ { 99 } { 44 } ifelse }');
      const expectedProgram = [5, 'jz', 99, 6, 'j', 44];
      expect(program).toMatchArray(expectedProgram);
    });
    it('handles missing brackets', () => {
      expect(() => { parse('{'); }).toThrow(
          new Error('Unexpected symbol: found undefined expected 1.'));
    });
    it('handles junk after the end', () => {
      const number = 3.3;
      const program = parse(`{ ${number} }#`);
      const expectedProgram = [number];
      expect(program).toMatchArray(expectedProgram);
    });
  });

  describe('PostScriptEvaluator', () => {
    function evaluate(program) {
      const stream = new StringStream(program);
      const parser = new PostScriptParser(new PostScriptLexer(stream));
      const code = parser.parse();
      const evaluator = new PostScriptEvaluator(code);
      const output = evaluator.execute();
      return output;
    }

    it('pushes stack', () => {
      const stack = evaluate('{ 99 }');
      const expectedStack = [99];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles if with true', () => {
      const stack = evaluate('{ 1 {99} if }');
      const expectedStack = [99];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles if with false', () => {
      const stack = evaluate('{ 0 {99} if }');
      const expectedStack = [];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles ifelse with true', () => {
      const stack = evaluate('{ 1 {99} {77} ifelse }');
      const expectedStack = [99];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles ifelse with false', () => {
      const stack = evaluate('{ 0 {99} {77} ifelse }');
      const expectedStack = [77];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles nested if', () => {
      const stack = evaluate('{ 1 {1 {77} if} if }');
      const expectedStack = [77];
      expect(stack).toMatchArray(expectedStack);
    });

    it('abs', () => {
      const stack = evaluate('{ -2 abs }');
      const expectedStack = [2];
      expect(stack).toMatchArray(expectedStack);
    });
    it('adds', () => {
      const stack = evaluate('{ 1 2 add }');
      const expectedStack = [3];
      expect(stack).toMatchArray(expectedStack);
    });
    it('boolean and', () => {
      const stack = evaluate('{ true false and }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('bitwise and', () => {
      const stack = evaluate('{ 254 1 and }');
      const expectedStack = [254 & 1];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates the inverse tangent of a number', () => {
      const stack = evaluate('{ 90 atan }');
      const expectedStack = [Math.atan(90)];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles bitshifting ', () => {
      const stack = evaluate('{ 50 2 bitshift }');
      const expectedStack = [200];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates the ceiling value', () => {
      const stack = evaluate('{ 9.9 ceiling }');
      const expectedStack = [10];
      expect(stack).toMatchArray(expectedStack);
    });
    it('copies', () => {
      const stack = evaluate('{ 99 98 2 copy }');
      const expectedStack = [99, 98, 99, 98];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates the cosine of a number', () => {
      const stack = evaluate('{ 90 cos }');
      const expectedStack = [Math.cos(90)];
      expect(stack).toMatchArray(expectedStack);
    });
    it('converts to int', () => {
      const stack = evaluate('{ 9.9 cvi }');
      const expectedStack = [9];
      expect(stack).toMatchArray(expectedStack);
    });
    it('converts negatives to int', () => {
      const stack = evaluate('{ -9.9 cvi }');
      const expectedStack = [-9];
      expect(stack).toMatchArray(expectedStack);
    });
    it('converts to real', () => {
      const stack = evaluate('{ 55.34 cvr }');
      const expectedStack = [55.34];
      expect(stack).toMatchArray(expectedStack);
    });
    it('divides', () => {
      const stack = evaluate('{ 6 5 div }');
      const expectedStack = [1.2];
      expect(stack).toMatchArray(expectedStack);
    });
    it('maps division by zero to infinity', () => {
      const stack = evaluate('{ 6 0 div }');
      const expectedStack = [Infinity];
      expect(stack).toMatchArray(expectedStack);
    });
    it('duplicates', () => {
      const stack = evaluate('{ 99 dup }');
      const expectedStack = [99, 99];
      expect(stack).toMatchArray(expectedStack);
    });
    it('accepts an equality', () => {
      const stack = evaluate('{ 9 9 eq }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rejects an inequality', () => {
      const stack = evaluate('{ 9 8 eq }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('exchanges', () => {
      const stack = evaluate('{ 44 99 exch }');
      const expectedStack = [99, 44];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles exponentiation', () => {
      const stack = evaluate('{ 10 2 exp }');
      const expectedStack = [100];
      expect(stack).toMatchArray(expectedStack);
    });
    it('pushes false onto the stack', () => {
      const stack = evaluate('{ false }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates the floor value', () => {
      const stack = evaluate('{ 9.9 floor }');
      const expectedStack = [9];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles greater than or equal to', () => {
      const stack = evaluate('{ 10 9 ge }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rejects less than for greater than or equal to', () => {
      const stack = evaluate('{ 8 9 ge }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles greater than', () => {
      const stack = evaluate('{ 10 9 gt }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rejects less than or equal for greater than', () => {
      const stack = evaluate('{ 9 9 gt }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('divides to integer', () => {
      const stack = evaluate('{ 2 3 idiv }');
      const expectedStack = [0];
      expect(stack).toMatchArray(expectedStack);
    });
    it('divides to negative integer', () => {
      const stack = evaluate('{ -2 3 idiv }');
      const expectedStack = [0];
      expect(stack).toMatchArray(expectedStack);
    });
    it('duplicates index', () => {
      const stack = evaluate('{ 4 3 2 1 2 index }');
      const expectedStack = [4, 3, 2, 1, 3];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles less than or equal to', () => {
      const stack = evaluate('{ 9 10 le }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rejects greater than for less than or equal to', () => {
      const stack = evaluate('{ 10 9 le }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates the natural logarithm', () => {
      const stack = evaluate('{ 10 ln }');
      const expectedStack = [Math.log(10)];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates the base 10 logarithm', () => {
      const stack = evaluate('{ 100 log }');
      const expectedStack = [2];
      expect(stack).toMatchArray(expectedStack);
    });
    it('handles less than', () => {
      const stack = evaluate('{ 9 10 lt }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rejects greater than or equal to for less than', () => {
      const stack = evaluate('{ 10 9 lt }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('performs the modulo operation', () => {
      const stack = evaluate('{ 4 3 mod }');
      const expectedStack = [1];
      expect(stack).toMatchArray(expectedStack);
    });
    it('multiplies two numbers (positive result)', () => {
      const stack = evaluate('{ 9 8 mul }');
      const expectedStack = [72];
      expect(stack).toMatchArray(expectedStack);
    });
    it('multiplies two numbers (negative result)', () => {
      const stack = evaluate('{ 9 -8 mul }');
      const expectedStack = [-72];
      expect(stack).toMatchArray(expectedStack);
    });
    it('accepts an inequality', () => {
      const stack = evaluate('{ 9 8 ne }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rejects an equality', () => {
      const stack = evaluate('{ 9 9 ne }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('negates', () => {
      const stack = evaluate('{ 4.5 neg }');
      const expectedStack = [-4.5];
      expect(stack).toMatchArray(expectedStack);
    });
    it('boolean not', () => {
      const stack = evaluate('{ true not }');
      const expectedStack = [false];
      expect(stack).toMatchArray(expectedStack);
    });
    it('bitwise not', () => {
      const stack = evaluate('{ 12 not }');
      const expectedStack = [-13];
      expect(stack).toMatchArray(expectedStack);
    });
    it('boolean or', () => {
      const stack = evaluate('{ true false or }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('bitwise or', () => {
      const stack = evaluate('{ 254 1 or }');
      const expectedStack = [254 | 1];
      expect(stack).toMatchArray(expectedStack);
    });
    it('pops stack', () => {
      const stack = evaluate('{ 1 2 pop }');
      const expectedStack = [1];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rolls stack right', () => {
      const stack = evaluate('{ 1 3 2 2 4 1 roll }');
      const expectedStack = [2, 1, 3, 2];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rolls stack left', () => {
      const stack = evaluate('{ 1 3 2 2 4 -1 roll }');
      const expectedStack = [3, 2, 2, 1];
      expect(stack).toMatchArray(expectedStack);
    });
    it('rounds a number', () => {
      const stack = evaluate('{ 9.52 round }');
      const expectedStack = [10];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates the sine of a number', () => {
      const stack = evaluate('{ 90 sin }');
      const expectedStack = [Math.sin(90)];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates a square root (integer)', () => {
      const stack = evaluate('{ 100 sqrt }');
      const expectedStack = [10];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates a square root (float)', () => {
      const stack = evaluate('{ 99 sqrt }');
      const expectedStack = [Math.sqrt(99)];
      expect(stack).toMatchArray(expectedStack);
    });
    it('subtracts (positive result)', () => {
      const stack = evaluate('{ 6 4 sub }');
      const expectedStack = [2];
      expect(stack).toMatchArray(expectedStack);
    });
    it('subtracts (negative result)', () => {
      const stack = evaluate('{ 4 6 sub }');
      const expectedStack = [-2];
      expect(stack).toMatchArray(expectedStack);
    });
    it('pushes true onto the stack', () => {
      const stack = evaluate('{ true }');
      const expectedStack = [true];
      expect(stack).toMatchArray(expectedStack);
    });
    it('truncates a number', () => {
      const stack = evaluate('{ 35.004 truncate }');
      const expectedStack = [35];
      expect(stack).toMatchArray(expectedStack);
    });
    it('calculates an exclusive or value', () => {
      const stack = evaluate('{ 3 9 xor }');
      const expectedStack = [10];
      expect(stack).toMatchArray(expectedStack);
    });
  });


  describe('PostScriptCompiler', () => {
    function check(code, domain, range, samples) {
      const compiler = new PostScriptCompiler();
      const compiledCode = compiler.compile(code, domain, range);
      if (samples === null) {
        expect(compiledCode).toBeNull();
      } else {
        expect(compiledCode).not.toBeNull();
        /* jshint -W054 */
        const fn = new Function('src', 'srcOffset', 'dest', 'destOffset',
            compiledCode);
        for (let i = 0; i < samples.length; i++) {
          const out = new Float32Array(samples[i].output.length);
          fn(samples[i].input, 0, out, 0);
          expect(Array.prototype.slice.call(out, 0))
              .toMatchArray(samples[i].output);
        }
      }
    }

    it('check compiled add', () => {
      check([0.25, 0.5, 'add'], [], [0, 1], [{input: [], output: [0.75]}]);
      check([0, 'add'], [0, 1], [0, 1], [{input: [0.25], output: [0.25]}]);
      check([0.5, 'add'], [0, 1], [0, 1], [{input: [0.25], output: [0.75]}]);
      check([0, 'exch', 'add'], [0, 1], [0, 1],
          [{input: [0.25], output: [0.25]}]);
      check([0.5, 'exch', 'add'], [0, 1], [0, 1],
          [{input: [0.25], output: [0.75]}]);
      check(['add'], [0, 1, 0, 1], [0, 1],
          [{input: [0.25, 0.5], output: [0.75]}]);
      check(['add'], [0, 1], [0, 1], null);
    });
    it('check compiled sub', () => {
      check([0.5, 0.25, 'sub'], [], [0, 1], [{input: [], output: [0.25]}]);
      check([0, 'sub'], [0, 1], [0, 1], [{input: [0.25], output: [0.25]}]);
      check([0.5, 'sub'], [0, 1], [0, 1], [{input: [0.75], output: [0.25]}]);
      check([0, 'exch', 'sub'], [0, 1], [-1, 1],
          [{input: [0.25], output: [-0.25]}]);
      check([0.75, 'exch', 'sub'], [0, 1], [-1, 1],
          [{input: [0.25], output: [0.5]}]);
      check(['sub'], [0, 1, 0, 1], [-1, 1],
          [{input: [0.25, 0.5], output: [-0.25]}]);
      check(['sub'], [0, 1], [0, 1], null);

      check([1, 'dup', 3, 2, 'roll', 'sub', 'sub'], [0, 1], [0, 1],
          [{input: [0.75], output: [0.75]}]);
    });
    it('check compiled mul', () => {
      check([0.25, 0.5, 'mul'], [], [0, 1], [{input: [], output: [0.125]}]);
      check([0, 'mul'], [0, 1], [0, 1], [{input: [0.25], output: [0]}]);
      check([0.5, 'mul'], [0, 1], [0, 1], [{input: [0.25], output: [0.125]}]);
      check([1, 'mul'], [0, 1], [0, 1], [{input: [0.25], output: [0.25]}]);
      check([0, 'exch', 'mul'], [0, 1], [0, 1], [{input: [0.25], output: [0]}]);
      check([0.5, 'exch', 'mul'], [0, 1], [0, 1],
          [{input: [0.25], output: [0.125]}]);
      check([1, 'exch', 'mul'], [0, 1], [0, 1],
          [{input: [0.25], output: [0.25]}]);
      check(['mul'], [0, 1, 0, 1], [0, 1],
          [{input: [0.25, 0.5], output: [0.125]}]);
      check(['mul'], [0, 1], [0, 1], null);
    });
    it('check compiled max', () => {
      check(['dup', 0.75, 'gt', 7, 'jz', 'pop', 0.75], [0, 1], [0, 1],
          [{input: [0.5], output: [0.5]}]);
      check(['dup', 0.75, 'gt', 7, 'jz', 'pop', 0.75], [0, 1], [0, 1],
          [{input: [1], output: [0.75]}]);
      check(['dup', 0.75, 'gt', 5, 'jz', 'pop', 0.75], [0, 1], [0, 1], null);
    });
    it('check pop/roll/index', () => {
      check([1, 'pop'], [0, 1], [0, 1], [{input: [0.5], output: [0.5]}]);
      check([1, 3, -1, 'roll'], [0, 1, 0, 1], [0, 1, 0, 1, 0, 1],
          [{input: [0.25, 0.5], output: [0.5, 1, 0.25]}]);
      check([1, 3, 1, 'roll'], [0, 1, 0, 1], [0, 1, 0, 1, 0, 1],
          [{input: [0.25, 0.5], output: [1, 0.25, 0.5]}]);
      check([1, 3, 1.5, 'roll'], [0, 1, 0, 1], [0, 1, 0, 1, 0, 1], null);
      check([1, 1, 'index'], [0, 1], [0, 1, 0, 1, 0, 1],
          [{input: [0.5], output: [0.5, 1, 0.5]}]);
      check([1, 3, 'index', 'pop'], [0, 1], [0, 1], null);
      check([1, 0.5, 'index', 'pop'], [0, 1], [0, 1], null);
    });
    it('check input boundaries', () => {
      check([], [0, 0.5], [0, 1], [{input: [1], output: [0.5]}]);
      check([], [0.5, 1], [0, 1], [{input: [0], output: [0.5]}]);
      check(['dup'], [0.5, 0.75], [0, 1, 0, 1],
          [{input: [0], output: [0.5, 0.5]}]);
      check([], [100, 1001], [0, 10000], [{input: [1000], output: [1000]}]);
    });
    it('check output boundaries', () => {
      check([], [0, 1], [0, 0.5], [{input: [1], output: [0.5]}]);
      check([], [0, 1], [0.5, 1], [{input: [0], output: [0.5]}]);
      check(['dup'], [0, 1], [0.5, 1, 0.75, 1],
          [{input: [0], output: [0.5, 0.75]}]);
      check([], [0, 10000], [100, 1001], [{input: [1000], output: [1000]}]);
    });
    it('compile optimized', () => {
      const compiler = new PostScriptCompiler();
      const code = [0, 'add', 1, 1, 3, -1, 'roll', 'sub', 'sub', 1, 'mul'];
      const compiledCode = compiler.compile(code, [0, 1], [0, 1]);
      expect(compiledCode).toEqual(
          'dest[destOffset + 0] = Math.max(0, Math.min(1, src[srcOffset + 0]));');
    });
  });
});
