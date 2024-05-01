const HASH_LOG = 13;
const HASH_SIZE = (1 << HASH_LOG);
const HASH_MASK = (HASH_SIZE - 1);
const MAX_COPY = 32;
const MAX_LEN = 264; /* 256 + 8 */
const MAX_L1_DISTANCE = 8192;
const MAX_L2_DISTANCE = 8191;
const MAX_FARDISTANCE = (65535 + MAX_L2_DISTANCE - 1);

const MAX_COPY_LENGTH_ARRAY = Buffer.from([MAX_COPY - 1]);

function flz_literals(runs, srcArray, src, op) {
  while (runs >= MAX_COPY) {
    op.push(MAX_COPY_LENGTH_ARRAY);
    op.push(srcArray.slice(src, src + MAX_COPY));
    src += MAX_COPY;
    runs -= MAX_COPY;
  }
  if (runs > 0) {
    op.push(Buffer.from([runs - 1]));
    op.push(srcArray.slice(src, src + runs));
  }
}

function flz1_match(len, distance, op) {
  --distance;
  if (len > MAX_LEN - 2) {
    while (len > MAX_LEN - 2) {
      op.push(Buffer.from([
        (7 << 5) + (distance >> 8),
        MAX_LEN - 2 - 7 - 2,
        distance & 255
      ]));
      len -= MAX_LEN - 2;
    }
  }
  if (len < 7) {
    op.push(Buffer.from([
      (len << 5) + (distance >> 8),
      (distance & 255)
    ]));
  } else {
    op.push(Buffer.from([
      (7 << 5) + (distance >> 8),
      len - 7,
      (distance & 255)
    ]));
  }
}

function flz_hash(v) {
  let h = v * 2654435769 >> (32 - HASH_LOG);
  return h & HASH_MASK;
}

function flz_cmp(srcArray, p, q, r) {
  const start = p;
  while (q < r) {
    if (srcArray[p++] !== srcArray[q++]) break;
  }
  return p - start;
}


function fastlz1_compress(input) {
  let ip = 0;
  let ip_bound = input.length - 4; /* because readU32 */
  let ip_limit = input.length - 12 - 1;
  let op = [];

  let htab = [];

  /* initializes hash table */
  for (let hash = 0; hash < HASH_SIZE; ++hash) htab[hash] = 0;

  /* we start with literal copy */
  let anchor = 0;
  ip += 2;

  /* main loop */
  while (ip < ip_limit) {
    let ref, seq;
    let distance, cmp;

    /* find potential match */
    do {
      seq = input.readUint32LE(ip);
      let hash = flz_hash(seq);
      ref = htab[hash];
      htab[hash] = ip;
      distance = ip - ref;
      cmp = (distance < MAX_L1_DISTANCE) ? input.readUint32LE(ref) : 0x1000000;
      if (ip >= ip_limit) break;
      ++ip;
    } while (seq != cmp);

    if (ip >= ip_limit) break;
    --ip;

    if (ip > anchor) {
      flz_literals(ip - anchor, input, anchor, op);
    }

    let len = flz_cmp(input, ref + 3, ip + 3, ip_bound);
    flz1_match(len, distance, op);

    /* update the hash at match boundary */
    ip += len;
    seq = input.readUint32LE(ip);
    let hash = flz_hash(seq);
    htab[hash] = ip++;
    seq >>= 8;
    hash = flz_hash(seq);
    htab[hash] = ip++;

    anchor = ip;
  }

  let copy = input.length - anchor;
  flz_literals(copy, input, anchor, op);
  return Buffer.concat(op);
}

function fastlz1_decompress(input) {
  let ip = 0;
  let ip_limit = input.length;
  let ip_bound = ip_limit - 2;
  let op = []
  let ctrl = input[ip++] & 31;

  while (1) {
    if (ctrl >= 32) {
      let len = (ctrl >> 5) - 1;
      let ofs = (ctrl & 31) << 8;
      ref = op.length - ofs - 1;
      if (len == 7 - 1) {
        if (!(ip <= ip_bound)) throw new RangeError();
        len += input[ip++];
      }
      ref -= input[ip++];
      len += 3;
      if (!(ref >= 0)) throw new RangeError();
      for (let i = ref ; i < ref + len; i++) op.push(op[i]);
    } else {
      ctrl++;
      if(!(ip + ctrl <= ip_limit)) throw new RangeError();
      for (let i = 0; i < ctrl; i++) op.push(input[ip+i]);
      ip += ctrl;
    }

    if (ip > ip_bound) break;
    ctrl = input[ip++];
  }

  return Buffer.from(op);
}

function flz2_match(len, distance, op) {
  --distance;
  if (distance < MAX_L2_DISTANCE) {
    if (len < 7) {
      op.push(Buffer.from([
        (len << 5) + (distance >> 8),
        (distance & 255)
      ]));
    } else {
      op.push(Buffer.from([(7 << 5) + (distance >> 8)]));
      for (len -= 7; len >= 255; len -= 255) op.push(Buffer.from([255]));
      op.push(Buffer.from([
        len,
        distance & 255
      ]));
    }
  } else {
    /* far away, but not yet in the another galaxy... */
    if (len < 7) {
      distance -= MAX_L2_DISTANCE;
      op.push(Buffer.from([
        (len << 5) + 31,
        255,
        distance >> 8,
        distance & 255
      ]));
    } else {
      distance -= MAX_L2_DISTANCE;
      op.push(Buffer.from([(7 << 5) + 31]));
      for (len -= 7; len >= 255; len -= 255) op.push(Buffer.from([255]));
      op.push(Buffer.from([
        len,
        255,
        distance >> 8,
        distance & 255
      ]));
    }
  }
}

function fastlz2_compress(input) {
  let ip = 0;
  let ip_bound = input.length - 4; /* because readU32 */
  let ip_limit = input.length - 12 - 1;
  let op = [];

  let htab = [];

  /* initializes hash table */
  for (let hash = 0; hash < HASH_SIZE; ++hash) htab[hash] = 0;

  /* we start with literal copy */
  let anchor = 0;
  ip += 2;

  /* main loop */
  while (ip < ip_limit) {
    let ref, seq;
    let distance, cmp;

    /* find potential match */
    do {
      seq = input.readUint32LE(ip);
      let hash = flz_hash(seq);
      ref = htab[hash];
      htab[hash] = ip;
      distance = ip - ref;
      cmp = distance < MAX_FARDISTANCE ? input.readUint32LE(ref) : 0x1000000;
      if (ip >= ip_limit) break;
      ++ip;
    } while (seq != cmp);

    if (ip >= ip_limit) break;
    --ip;

    /* far, needs at least 5-byte match */
    if (distance >= MAX_L2_DISTANCE) {
      if (input[ref + 3] != input[ip + 3] || input[ref + 4] != input[ip + 4]) {
        ++ip;
        continue;
      }
    }

    if (ip > anchor) {
      flz_literals(ip - anchor, input, anchor, op);
    }

    let len = flz_cmp(input, ref + 3, ip + 3, ip_bound);
    flz2_match(len, distance, op);

    /* update the hash at match boundary */
    ip += len;
    seq = input.readUint32LE(ip);
    let hash = flz_hash(seq);
    htab[hash] = ip++;
    seq >>= 8;
    hash = flz_hash(seq);
    htab[hash] = ip++;

    anchor = ip;
  }

  let copy = input.length - anchor;
  flz_literals(copy, input, anchor, op);

  /* marker for fastlz2 */
  op[0][0] |= (1 << 5);

  return Buffer.concat(op);
}


function fastlz2_decompress(input) {
  let ip = 0;
  let ip_limit = input.length;
  let ip_bound = ip_limit - 2;
  let op = []
  let ctrl = input[ip++] & 31;

  while (1) {
    if (ctrl >= 32) {
      let len = (ctrl >> 5) - 1;
      let ofs = (ctrl & 31) << 8;
      let ref = op.length - ofs - 1;

      let code;
      if (len == 7 - 1) {
        do {
          if (!(ip <= ip_bound)) throw new RangeError();
          code = input[ip++];
          len += code;
        } while (code == 255);
      }
      code = input[ip++];
      ref -= code;
      len += 3;

      /* match from 16-bit distance */
      if (code == 255) {
        if (ofs == (31 << 8)) {
          if (!(ip < ip_bound)) throw new RangeError();
          ofs = input[ip++] << 8;
          ofs += input[ip++];
          ref = op.length - ofs - MAX_L2_DISTANCE - 1;
        }
      }

      if (!(ref >= 0)) throw new RangeError();
      for (let i = ref ; i < ref + len; i++) op.push(op[i]);
    } else {
      ctrl++;
      if(!(ip + ctrl <= ip_limit)) throw new RangeError();
      for (let i = 0; i < ctrl; i++) op.push(input[ip+i]);
      ip += ctrl;
    }

    if (ip >= ip_limit) break;
    ctrl = input[ip++];
  }

  return Buffer.from(op);
}

function fastlz_compress(input) {
  /* for short block, choose fastlz1 */
  if (input.length < 65536) return fastlz1_compress(input);

  /* else... */
  return fastlz2_compress(input);
}

function fastlz_decompress(input) {
  /* magic identifier for compression level */
  let level = (input[0] >> 5) + 1;
console.log({level})
  if (level == 1) return fastlz1_decompress(input);
  if (level == 2) return fastlz2_decompress(input);

  /* unknown level, trigger error */
  throw new Error('unknown level');
}

function fastlz_compress_level(input, level) {
  if (level == 1) return fastlz1_compress(input);
  if (level == 2) return fastlz2_compress(input);

  throw new Error('unknown level');
}

module.exports.compress = fastlz_compress;
module.exports.decompress = fastlz_decompress;
module.exports.compress_level = fastlz_compress_level;

