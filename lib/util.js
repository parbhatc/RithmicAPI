export function toPlain(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_, value) => {
      if (value && typeof value === "object" && typeof value.toNumber === "function") {
        return value.toNumber();
      }
      return value;
    }),
  );
}

/** `log: true` on sessions, or `RITHMIC_DEBUG=1` in the environment. */
export function resolveLog(value) {
  if (value != null) return Boolean(value);
  const v = process.env.RITHMIC_DEBUG;
  return v === "1" || v === "true";
}

/** Read template_id (field 154467) from a protobuf body. */
export function peekTemplateId(buffer) {
  let pos = 0;
  while (pos < buffer.length) {
    const [tag, next] = readVarint(buffer, pos);
    pos = next;
    const field = tag >> 3;
    const wire = tag & 7;

    if (wire === 0) {
      const [value, nextPos] = readVarint(buffer, pos);
      pos = nextPos;
      if (field === 154467) return value;
    } else if (wire === 2) {
      const [len, nextPos] = readVarint(buffer, pos);
      pos = nextPos + len;
    } else {
      break;
    }
  }
  throw new Error("template_id not found in message");
}

function readVarint(buffer, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buffer.length) {
    const b = buffer[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
  throw new Error("truncated varint");
}
