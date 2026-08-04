// Minimal post-processing node surface used when importing render-pipeline.js
// in unit tests. The render-path tests bypass its WebGPU-heavy constructor.
const node = new Proxy(function stubNode() {}, {
  get() { return node; },
  apply() { return node; }
});

export default class DisplayNodeStub {}
export const ao = () => node;
export const smaa = () => node;
