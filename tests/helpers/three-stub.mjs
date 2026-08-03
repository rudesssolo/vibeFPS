// Stub di 'three' per i test Node: solo la superficie usata dai moduli sotto
// test. Vector3 e Color hanno comportamento REALE (i test verificano moto e
// cicli di vita); geometrie, mesh e materiali sono contenitori inerti.

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(value) { this.x = this.y = this.z = value; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
  length() { return Math.sqrt(this.lengthSq()); }
  distanceToSquared(v) { return (this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2; }
  distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
}

export class Color {
  constructor(value = 0xffffff) { this.r = 1; this.g = 1; this.b = 1; this.set(value); }
  set(value) {
    const hex = typeof value === 'number' ? value : 0xffffff;
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  }
  getHex() {
    return (Math.round(this.r * 255) << 16) | (Math.round(this.g * 255) << 8) | Math.round(this.b * 255);
  }
}

export class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
    this.usage = null;
    this.needsUpdate = false;
  }
  setUsage(usage) { this.usage = usage; return this; }
}

export class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; this.disposed = false; }
  setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
  getAttribute(name) { return this.attributes[name]; }
  deleteAttribute(name) { delete this.attributes[name]; return this; }
  setIndex(index) { this.index = index; return this; }
  getIndex() { return this.index; }
  dispose() { this.disposed = true; }
}

export class IcosahedronGeometry extends BufferGeometry {
  // Il conteggio reale (960 vertici per detail 2) non serve al test: basta che
  // gli attributi per-puff siano dimensionati in modo coerente.
  constructor(radius = 1, detail = 0) {
    super();
    const count = 12;
    this.parameters = { radius, detail };
    this.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    this.setAttribute('normal', new BufferAttribute(new Float32Array(count * 3), 3));
    this.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  }
}

export class Object3D {
  constructor() {
    this.position = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.visible = true;
    this.frustumCulled = true;
    this.children = [];
  }
  add(...objects) { this.children.push(...objects); return this; }
  remove(...objects) {
    for (const object of objects) {
      const index = this.children.indexOf(object);
      if (index >= 0) this.children.splice(index, 1);
    }
    return this;
  }
}

export class Mesh extends Object3D {
  constructor(geometry = null, material = null) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}

export class Scene extends Object3D {}

export class NodeMaterial {
  constructor() { this.disposed = false; }
  dispose() { this.disposed = true; }
}

export const DynamicDrawUsage = 35048;
export const FrontSide = 0;
export const BackSide = 1;
export const DoubleSide = 2;
export const NormalBlending = 1;
export const AdditiveBlending = 2;
export const CustomBlending = 5;
export const OneFactor = 201;
export const OneMinusSrcAlphaFactor = 205;
