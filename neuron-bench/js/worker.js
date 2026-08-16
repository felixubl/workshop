// Neuron Bench: the training thread.
//
// The page owns the picture, this owns the arithmetic. They are separated for
// one reason: a network big enough to be interesting takes long enough that
// doing it on the main thread would freeze the tab, and a frozen tab teaches
// nothing. Here the user can watch the loss fall and stop it whenever.
//
// The worker holds the only live network. The page gets snapshots — weights
// and biases as plain arrays — at a fixed wall-clock rate rather than every
// epoch, because a small network can run thousands of epochs a second and
// posting each one would make the messages, not the maths, the bottleneck.

/* global MLP */
importScripts('mlp.js');

let net = null;
let train = null;      // { X, Y, n, order }
let test = null;       // { X, Y, n }
let opts = null;
let running = false;
let stopAt = 0;
let rand = null;

const POST_MS = 90;

function metrics() {
  const tr = MLP.evaluate(net, train.X, train.Y, train.n);
  const te = test && test.n ? MLP.evaluate(net, test.X, test.Y, test.n) : null;
  return {
    epoch: net.epoch,
    trainLoss: tr.loss, trainAcc: tr.accuracy,
    testLoss: te ? te.loss : null, testAcc: te ? te.accuracy : null
  };
}

function post(type, extra) {
  postMessage(Object.assign({ type, snapshot: MLP.snapshot(net) }, metrics(), extra || {}));
}

/* One slice of work, then yield. The slice is measured in time rather than
   epochs so the message rate stays steady whether the network is four weights
   or four hundred thousand. */
function slice() {
  if (!running) return;
  const until = performance.now() + POST_MS;
  let ran = 0;

  while (performance.now() < until) {
    if (stopAt && net.epoch >= stopAt) break;
    MLP.trainEpoch(net, train.X, train.Y, train.n, {
      lr: opts.lr, batchSize: opts.batchSize, momentum: opts.momentum,
      clip: opts.clip, order: train.order, rand
    });
    ran++;
    /* A single epoch of a large network can outlast the slice on its own.
       Checking after each one keeps that case responsive instead of
       overshooting by however long the epoch took. */
    if (ran >= 1 && performance.now() >= until) break;
  }

  const done = stopAt && net.epoch >= stopAt;
  const bad = !Number.isFinite(metrics().trainLoss);

  if (done || bad) {
    running = false;
    post('done', { reason: bad ? 'diverged' : 'reached' });
    return;
  }
  post('progress');
  setTimeout(slice, 0);
}

onmessage = function (e) {
  const m = e.data;

  if (m.type === 'init') {
    net = MLP.create(m.spec);
    train = { X: m.trainX, Y: m.trainY, n: m.trainN, order: new Uint32Array(m.trainN) };
    for (let i = 0; i < m.trainN; i++) train.order[i] = i;
    test = m.testN ? { X: m.testX, Y: m.testY, n: m.testN } : null;
    rand = MLP.rng(m.spec.seed + ':shuffle');
    running = false;
    post('ready', { params: MLP.paramCount(net) });
    return;
  }

  if (m.type === 'start') {
    if (!net || running) return;
    opts = m.opts;
    stopAt = m.until || 0;
    running = true;
    slice();
    return;
  }

  if (m.type === 'stop') {
    running = false;
    if (net) post('done', { reason: 'stopped' });
    return;
  }

  /* One epoch, for the step button. Same code path as a run, so stepping and
     running cannot drift apart. */
  if (m.type === 'step') {
    if (!net || running) return;
    opts = m.opts;
    MLP.trainEpoch(net, train.X, train.Y, train.n, {
      lr: opts.lr, batchSize: opts.batchSize, momentum: opts.momentum,
      clip: opts.clip, order: train.order, rand
    });
    post('progress');
    return;
  }

  if (m.type === 'reset') {
    if (!net) return;
    running = false;
    net = MLP.create(m.spec);
    rand = MLP.rng(m.spec.seed + ':shuffle');
    post('ready', { params: MLP.paramCount(net) });
  }
};
