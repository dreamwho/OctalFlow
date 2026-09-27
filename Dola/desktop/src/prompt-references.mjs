export function referenceLabel(index) { return `图片${index + 1}`; }

export function nextReferenceLabel(references) {
  const numbers = references.map((item) => Number(/^图片(\d+)$/u.exec(item.label || "")?.[1] || 0));
  return `图片${Math.max(0, ...numbers) + 1}`;
}

export function normalizePictureTags(value, references) {
  return value.replace(/<Picture\s+(\d+)>/giu, (tag, number) => references.some((item) => item.label === `图片${number}`) ? `@图片${number}` : tag);
}

export function referencedIds(value, references) {
  return new Set(references.filter((item) => {
    const number = /^图片(\d+)$/u.exec(item.label || "")?.[1];
    return number && new RegExp(`[@＠]图片${number}(?!\\d)`, "u").test(value);
  }).map((item) => item.id));
}

export function mentionAtCursor(value, cursor) {
  const prefix = value.slice(0, cursor);
  const match = /[@＠]([^\s@＠]*)$/u.exec(prefix);
  return match ? { start: cursor - match[0].length, end: cursor, query: match[1] } : null;
}

export function replaceMention(value, mention, label) {
  const inserted = `@${label} `;
  return { value: value.slice(0, mention.start) + inserted + value.slice(mention.end), cursor: mention.start + inserted.length };
}

export function replaceReferenceToken(value, start, end, label) {
  const inserted = `@${label}`;
  return { value: value.slice(0, start) + inserted + value.slice(end), cursor: start + inserted.length };
}

export function deleteReferenceAtCaret(value, cursor, key, labels) {
  if (key !== "Backspace" && key !== "Delete") return null;
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    for (const marker of [`@${label}`, `＠${label}`]) {
      for (let index = value.indexOf(marker); index >= 0; index = value.indexOf(marker, index + marker.length)) {
        const end = index + marker.length;
        if ((key === "Backspace" && cursor > index && cursor <= end + 1) || (key === "Delete" && cursor >= index && cursor < end)) {
          const removeEnd = value[end] === " " ? end + 1 : end;
          return { value: value.slice(0, index) + value.slice(removeEnd), cursor: index };
        }
      }
    }
  }
  return null;
}
