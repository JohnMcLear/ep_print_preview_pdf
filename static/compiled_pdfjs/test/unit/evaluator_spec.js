/* globals expect, it, describe, PartialEvaluator, StringStream, OPS,
           OperatorList, waitsFor, runs, Dict, Name, Stream, WorkerTask */

'use strict';

describe('evaluator', () => {
  function XrefMock(queue) {
    this.queue = queue || [];
  }
  XrefMock.prototype = {
    fetchIfRef() {
      return this.queue.shift();
    },
  };
  function HandlerMock() {
    this.inputs = [];
  }
  HandlerMock.prototype = {
    send(name, data) {
      this.inputs.push({name, data});
    },
  };
  function ResourcesMock() { }
  ResourcesMock.prototype = {
    get(name) {
      return this[name];
    },
  };

  function PdfManagerMock() { }

  function runOperatorListCheck(evaluator, stream, resources, check) {
    let done = false;
    runs(() => {
      const result = new OperatorList();
      const task = new WorkerTask('OperatorListCheck');
      evaluator.getOperatorList(stream, task, resources, result).then(
          () => {
            check(result);
            done = true;
          });
    });
    waitsFor(() => done);
  }

  describe('splitCombinedOperations', () => {
    it('should reject unknown operations', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('fTT');

      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(!!result.fnArray && !!result.argsArray).toEqual(true);
            expect(result.fnArray.length).toEqual(1);
            expect(result.fnArray[0]).toEqual(OPS.fill);
            expect(result.argsArray[0]).toEqual(null);
          });
    });

    it('should handle one operations', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('Q');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(!!result.fnArray && !!result.argsArray).toEqual(true);
            expect(result.fnArray.length).toEqual(1);
            expect(result.fnArray[0]).toEqual(OPS.restore);
          });
    });

    it('should handle two glued operations', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const resources = new ResourcesMock();
      resources.Res1 = {};
      const stream = new StringStream('/Res1 DoQ');
      runOperatorListCheck(evaluator, stream, resources, (result) => {
        expect(!!result.fnArray && !!result.argsArray).toEqual(true);
        expect(result.fnArray.length).toEqual(2);
        expect(result.fnArray[0]).toEqual(OPS.paintXObject);
        expect(result.fnArray[1]).toEqual(OPS.restore);
      });
    });

    it('should handle tree glued operations', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('fff');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(!!result.fnArray && !!result.argsArray).toEqual(true);
            expect(result.fnArray.length).toEqual(3);
            expect(result.fnArray[0]).toEqual(OPS.fill);
            expect(result.fnArray[1]).toEqual(OPS.fill);
            expect(result.fnArray[2]).toEqual(OPS.fill);
          });
    });

    it('should handle three glued operations #2', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const resources = new ResourcesMock();
      resources.Res1 = {};
      const stream = new StringStream('B*Bf*');
      runOperatorListCheck(evaluator, stream, resources, (result) => {
        expect(!!result.fnArray && !!result.argsArray).toEqual(true);
        expect(result.fnArray.length).toEqual(3);
        expect(result.fnArray[0]).toEqual(OPS.eoFillStroke);
        expect(result.fnArray[1]).toEqual(OPS.fillStroke);
        expect(result.fnArray[2]).toEqual(OPS.eoFill);
      });
    });

    it('should handle glued operations and operands', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('f5 Ts');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(!!result.fnArray && !!result.argsArray).toEqual(true);
            expect(result.fnArray.length).toEqual(2);
            expect(result.fnArray[0]).toEqual(OPS.fill);
            expect(result.fnArray[1]).toEqual(OPS.setTextRise);
            expect(result.argsArray.length).toEqual(2);
            expect(result.argsArray[1].length).toEqual(1);
            expect(result.argsArray[1][0]).toEqual(5);
          });
    });

    it('should handle glued operations and literals', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('trueifalserinulln');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(!!result.fnArray && !!result.argsArray).toEqual(true);
            expect(result.fnArray.length).toEqual(3);
            expect(result.fnArray[0]).toEqual(OPS.setFlatness);
            expect(result.fnArray[1]).toEqual(OPS.setRenderingIntent);
            expect(result.fnArray[2]).toEqual(OPS.endPath);
            expect(result.argsArray.length).toEqual(3);
            expect(result.argsArray[0].length).toEqual(1);
            expect(result.argsArray[0][0]).toEqual(true);
            expect(result.argsArray[1].length).toEqual(1);
            expect(result.argsArray[1][0]).toEqual(false);
            expect(result.argsArray[2]).toEqual(null);
          });
    });
  });

  describe('validateNumberOfArgs', () => {
    it('should execute if correct number of arguments', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('5 1 d0');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(result.argsArray[0][0]).toEqual(5);
            expect(result.argsArray[0][1]).toEqual(1);
            expect(result.fnArray[0]).toEqual(OPS.setCharWidth);
          });
    });
    it('should execute if too many arguments', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('5 1 4 d0');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(result.argsArray[0][0]).toEqual(1);
            expect(result.argsArray[0][1]).toEqual(4);
            expect(result.fnArray[0]).toEqual(OPS.setCharWidth);
          });
    });
    it('should execute if nested commands', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('/F2 /GS2 gs 5.711 Tf');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(result.fnArray.length).toEqual(3);
            expect(result.fnArray[0]).toEqual(OPS.setGState);
            expect(result.fnArray[1]).toEqual(OPS.dependency);
            expect(result.fnArray[2]).toEqual(OPS.setFont);
            expect(result.argsArray.length).toEqual(3);
            expect(result.argsArray[0].length).toEqual(1);
            expect(result.argsArray[1].length).toEqual(1);
            expect(result.argsArray[2].length).toEqual(2);
          });
    });
    it('should skip if too few arguments', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('5 d0');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(result.argsArray).toEqual([]);
            expect(result.fnArray).toEqual([]);
          });
    });
    it('should close opened saves', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('qq');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(!!result.fnArray && !!result.argsArray).toEqual(true);
            expect(result.fnArray.length).toEqual(4);
            expect(result.fnArray[0]).toEqual(OPS.save);
            expect(result.fnArray[1]).toEqual(OPS.save);
            expect(result.fnArray[2]).toEqual(OPS.restore);
            expect(result.fnArray[3]).toEqual(OPS.restore);
          });
    });
    it('should skip paintXObject if name is missing', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('/ Do');
      runOperatorListCheck(evaluator, stream, new ResourcesMock(),
          (result) => {
            expect(result.argsArray).toEqual([]);
            expect(result.fnArray).toEqual([]);
          });
    });
    it('should skip paintXObject if subtype is PS', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const xobjStreamDict = new Dict();
      xobjStreamDict.set('Subtype', Name.get('PS'));
      const xobjStream = new Stream([], 0, 0, xobjStreamDict);

      const xobjs = new Dict();
      xobjs.set('Res1', xobjStream);

      const resources = new Dict();
      resources.set('XObject', xobjs);

      const stream = new StringStream('/Res1 Do');
      runOperatorListCheck(evaluator, stream, resources, (result) => {
        expect(result.argsArray).toEqual([]);
        expect(result.fnArray).toEqual([]);
      });
    });
  });

  describe('thread control', () => {
    it('should abort operator list parsing', () => {
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('qqQQ');
      const resources = new ResourcesMock();
      let done = false;
      runs(() => {
        const result = new OperatorList();
        const task = new WorkerTask('OperatorListAbort');
        task.terminate();
        evaluator.getOperatorList(stream, task, resources, result).catch(
            () => {
              done = true;
              expect(!!result.fnArray && !!result.argsArray).toEqual(true);
              expect(result.fnArray.length).toEqual(0);
            });
      });
      waitsFor(() => done);
    });
    it('should abort text parsing parsing', () => {
      const resources = new ResourcesMock();
      const evaluator = new PartialEvaluator(new PdfManagerMock(),
          new XrefMock(), new HandlerMock(),
          'prefix');
      const stream = new StringStream('qqQQ');
      let done = false;
      runs(() => {
        const task = new WorkerTask('TextContentAbort');
        task.terminate();
        evaluator.getTextContent(stream, task, resources).catch(
            () => {
              done = true;
            });
      });
      waitsFor(() => done);
    });
  });

  describe('operator list', () => {
    function MessageHandlerMock() { }
    MessageHandlerMock.prototype = {
      send() { },
    };

    it('should get correct total length after flushing', () => {
      const operatorList = new OperatorList(null, new MessageHandlerMock());
      operatorList.addOp(OPS.save, null);
      operatorList.addOp(OPS.restore, null);

      expect(operatorList.totalLength).toEqual(2);
      expect(operatorList.length).toEqual(2);

      operatorList.flush();

      expect(operatorList.totalLength).toEqual(2);
      expect(operatorList.length).toEqual(0);
    });
  });
});
