function normalize(text) {
  return String(text).replace(/\r\n?/g, "\n").trim();
}

function bigrams(text) {
  const value = normalize(text);
  if (value.length < 2) return value ? [value] : [];
  const result = [];
  for (let index = 0; index < value.length - 1; index += 1) result.push(value.slice(index, index + 2));
  return result;
}

function diceSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map();
  for (const token of a) counts.set(token, (counts.get(token) || 0) + 1);
  let overlap = 0;
  for (const token of b) {
    const count = counts.get(token) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(token, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

function composerLines(text) {
  return normalize(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2);
}

export function chooseRevisionTarget(currentText, pending, isRevisionable = () => true) {
  const candidates = pending
    .filter((item) => isRevisionable(item.id))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 2);
  if (candidates.length === 0) return null;
  const current = normalize(currentText);
  const exact = candidates.find((item) => normalize(item.text) === current);
  if (exact) return exact;
  return candidates
    .map((item, index) => ({ item, score: diceSimilarity(current, item.text), recency: candidates.length - index }))
    .sort((left, right) => right.score - left.score || right.recency - left.recency)[0].item;
}

export function planComposerRevisions(currentText, pending, isRevisionable = () => true) {
  const lines = composerLines(currentText);
  const candidates = pending
    .filter((item) => isRevisionable(item.id))
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-2);
  if (lines.length === 0 || candidates.length === 0) return [];

  if (candidates.length === 1) {
    const rawLines = String(currentText).replace(/\r\n?/g, "\n").split("\n");
    const line = rawLines.length === 1 ? rawLines[0].trim() : rawLines.at(-2)?.trim();
    return normalize(line) === normalize(candidates[0].text)
      ? []
      : [{ pending: candidates[0], text: line }];
  }

  if (lines.length === 1) {
    const target = chooseRevisionTarget(lines[0], candidates, isRevisionable);
    return !target || normalize(lines[0]) === normalize(target.text)
      ? []
      : [{ pending: target, text: lines[0] }];
  }

  const directScore = diceSimilarity(lines[0], candidates[0].text)
    + diceSimilarity(lines[1], candidates[1].text)
    + 0.1;
  const swappedScore = diceSimilarity(lines[0], candidates[1].text)
    + diceSimilarity(lines[1], candidates[0].text);
  const assignment = directScore >= swappedScore
    ? [[lines[0], candidates[0]], [lines[1], candidates[1]]]
    : [[lines[0], candidates[1]], [lines[1], candidates[0]]];

  return assignment
    .filter(([line, item]) => normalize(line) !== normalize(item.text))
    .map(([line, item]) => ({ pending: item, text: line }));
}
