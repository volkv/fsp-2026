// Kubernetes manifests and pipeline files of DevOps items: the generator renders documents in a strict subset of YAML
// (two-space indents, block mappings and sequences, sequences of scalars in flow style, `---` between documents), and the
// reference programs of the gates parse the shown text back with their own parser of the same subset (`PY_YAML`; the
// sandbox has no YAML library), so the answer is proven on the text the candidate reads.

export type Scalar = string | number | boolean | null;
/** A value whose line number the generator needs: `{ $mark: id, v: value }`. */
export interface Marked {
	$mark: string;
	v: Scalar;
}
export type Yaml = Scalar | Marked | Yaml[] | { [key: string]: Yaml };

export const isMarked = (value: Yaml): value is Marked =>
	value !== null && typeof value === 'object' && !Array.isArray(value) && '$mark' in value;
const isLeaf = (value: Yaml): value is Scalar | Marked =>
	value === null || typeof value !== 'object' || isMarked(value);
const isPlain = (value: Yaml): value is Scalar => value === null || typeof value !== 'object';

function scalarText(value: Scalar): string {
	if (value === null) return 'null';
	if (typeof value !== 'string') return String(value);
	const plain =
		value !== '' &&
		!/^-?\d+(\.\d+)?$/.test(value) &&
		!['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'].includes(value.toLowerCase()) &&
		!/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
		!/:\s|\s#|:$|\s$/.test(value);
	return plain ? value : `"${value}"`;
}

/** Documents as YAML with two-space indents; every marked value reports the 1-based number of its line. */
export function renderYaml(docs: readonly Yaml[]): { text: string; marks: Map<string, number> } {
	const lines: string[] = [];
	const marks = new Map<string, number>();
	const leaf = (value: Scalar | Marked): string => {
		if (!isMarked(value)) return scalarText(value);
		marks.set(value.$mark, lines.length + 1);
		return scalarText(value.v);
	};
	const block = (value: Yaml, pad: string, first: string | null): void => {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isLeaf(item)) lines.push(`${pad}- ${leaf(item)}`);
				else if (Array.isArray(item)) throw new Error('nested sequences are not rendered');
				else block(item, `${pad}  `, `${pad}- `);
			}
			return;
		}
		if (isLeaf(value)) throw new Error('a scalar is not a block');
		let prefix = first;
		for (const [key, child] of Object.entries(value)) {
			const head = prefix ?? pad;
			prefix = null;
			if (isLeaf(child)) {
				const text = leaf(child);
				lines.push(`${head}${key}: ${text}`);
			} else if (Array.isArray(child) && child.every(isPlain))
				lines.push(`${head}${key}: [${child.map(scalarText).join(', ')}]`);
			else if (!Array.isArray(child) && Object.keys(child).length === 0) lines.push(`${head}${key}: {}`);
			else {
				lines.push(`${head}${key}:`);
				block(child, `${pad}  `, null);
			}
		}
		if (prefix !== null) lines.push(`${prefix}{}`);
	};
	docs.forEach((doc, i) => {
		if (i > 0) lines.push('---');
		block(doc, '', null);
	});
	return { text: lines.join('\n'), marks };
}

/** A parser of the YAML subset the generator renders, for the reference programs. */
export const PY_YAML = `import json, re, sys

def scalar(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\\"'":
        return s[1:-1]
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [scalar(x) for x in inner.split(",")] if inner else []
    if s == "{}":
        return {}
    if re.fullmatch(r"-?\\d+", s):
        return int(s)
    if s in ("true", "false"):
        return s == "true"
    return s

def block(lines, i, indent):
    if lines[i][1] == "-" or lines[i][1].startswith("- "):
        seq = []
        while i < len(lines) and lines[i][0] == indent and (lines[i][1] == "-" or lines[i][1].startswith("- ")):
            rest = lines[i][1][2:].strip()
            if re.match(r"^[^\\s\\"'\\[{][^:]*:(\\s|$)", rest):
                lines[i] = (indent + 2, rest)
                value, i = block(lines, i, indent + 2)
            else:
                value, i = scalar(rest), i + 1
            seq.append(value)
        return seq, i
    mapping = {}
    while i < len(lines) and lines[i][0] == indent and not lines[i][1].startswith("- "):
        key, _, rest = lines[i][1].partition(":")
        rest = rest.strip()
        if rest == "" and i + 1 < len(lines) and lines[i + 1][0] > indent:
            mapping[key], i = block(lines, i + 1, lines[i + 1][0])
        else:
            mapping[key], i = (None if rest == "" else scalar(rest)), i + 1
    return mapping, i

def parse_yaml(text):
    docs, chunk = [], []
    for raw in text.split("\\n") + ["---"]:
        if raw.strip() == "---":
            if chunk:
                docs.append(block(chunk, 0, chunk[0][0])[0])
            chunk = []
        elif raw.strip():
            chunk.append((len(raw) - len(raw.lstrip(" ")), raw.strip()))
    return docs

`;

/** The text of documents without marks. */
export function yamlText(docs: readonly Yaml[]): string {
	return renderYaml(docs).text;
}

/**
 * A parser of the pipeline files of CI items for the reference programs: scalars stay strings, flow sequences may hold
 * quoted commas, `#` comment lines are skipped and `key: |` takes the more indented lines as a literal block.
 */
export const PY_PIPELINE_YAML = String.raw`import json
import re

KEY = re.compile(r"^([A-Za-z0-9_.\-/]+):(?:\s+(.*))?$")


def split_flow(inner):
    parts, cur, quote = [], "", None
    for ch in inner:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            cur += ch
        elif ch == ",":
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return parts


def scalar(s):
    s = s.strip()
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [scalar(p) for p in split_flow(inner)] if inner else []
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        return s[1:-1]
    return s


def block(rows, i, indent):
    if rows[i][1] == "-" or rows[i][1].startswith("- "):
        items = []
        while i < len(rows) and rows[i][0] == indent and (rows[i][1] == "-" or rows[i][1].startswith("- ")):
            rest = rows[i][1][1:].strip()
            if not rest:
                value, i = block(rows, i + 1, rows[i + 1][0])
            elif KEY.match(rest):
                rows[i] = (indent + 2, rest)
                value, i = block(rows, i, indent + 2)
            else:
                value, i = scalar(rest), i + 1
            items.append(value)
        return items, i
    mapping = {}
    while i < len(rows) and rows[i][0] == indent:
        m = KEY.match(rows[i][1])
        if not m:
            raise ValueError("unexpected line: " + rows[i][1])
        key, rest = m.group(1), (m.group(2) or "").strip()
        i += 1
        if rest == "|":
            text = []
            while i < len(rows) and rows[i][0] > indent:
                text.append(rows[i][1])
                i += 1
            mapping[key] = "\n".join(text)
        elif rest:
            mapping[key] = scalar(rest)
        elif i < len(rows) and rows[i][0] > indent:
            mapping[key], i = block(rows, i, rows[i][0])
        else:
            mapping[key] = None
    return mapping, i


def parse_yaml(text):
    rows = []
    for raw in text.split("\n"):
        body = raw.strip()
        if body and not body.startswith("#"):
            rows.append((len(raw) - len(raw.lstrip(" ")), body))
    value, end = block(rows, 0, rows[0][0])
    if end != len(rows):
        raise ValueError("unparsed line: " + rows[end][1])
    return value
`;
