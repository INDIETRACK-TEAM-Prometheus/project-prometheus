import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNames, validNameRequest} from '../server/object-namer.js';
import {parsePredictions} from '../server/predictor.js';

const reply = (text, model = 'muse-spark-1.2') => ({status:'completed', model, output:[{type:'message', content:[{type:'output_text', text}]}]});

test('names are short lowercase words for known tiles; numbers and "unclear" are dropped', () => {
  const names = parseNames(reply(JSON.stringify({labels:[{tile:1, name:'Gray Suitcase'}, {tile:2, name:'3'}, {tile:3, name:'unclear'}, {tile:9, name:'cup'}, {tile:4, name:'<script>'}]})), 4, 'muse-spark-1.2');
  assert.deepEqual(names, ['gray suitcase', null, null, null]);
  assert.deepEqual(parseNames(reply(JSON.stringify({labels:[{tile:1, name:'3 - stainless steel refrigerator'}, {tile:2, name:'Tile 2: cup'}]})), 2, 'muse-spark-1.2'), ['stainless steel refrigerator', 'cup']);
  assert.deepEqual(parseNames(reply(JSON.stringify({labels:[{tile:1, name:'tile1'}, {tile:2, name:'Tile 4'}]})), 2, 'muse-spark-1.2'), [null, null]);
  assert.throws(() => parseNames(reply('{}', 'muse-spark-1.3'), 2, 'muse-spark-1.2'), {code:'NAMER_INVALID_RESPONSE'});
  assert.equal(validNameRequest({imageDataUrl:'data:image/jpeg;base64,/9j/AA==', tiles:3}), true);
  assert.equal(validNameRequest({imageDataUrl:'data:image/jpeg;base64,/9j/AA==', tiles:10}), false);
});

test('predictions are at most three plain strings', () => {
  assert.deepEqual(parsePredictions(reply(JSON.stringify({predictions:['may open the gray suitcase', 'x', 42]})), 'muse-spark-1.2'), ['may open the gray suitcase']);
  assert.throws(() => parsePredictions(reply(JSON.stringify({predictions:['a1a', 'b2b', 'c3c', 'd4d']})), 'muse-spark-1.2'), {code:'PREDICT_JSON_INVALID'});
});
