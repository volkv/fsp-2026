import sys


def main() -> None:
    lines = sys.stdin.read().splitlines()
    n = int(lines[0]) if lines else 0
    classes = [0] * 5
    slowest: tuple[int, str] | None = None
    counts: dict[str, int] = {}
    for line in lines[1 : n + 1]:
        _method, path, status, duration = line.split()
        classes[int(status) // 100 - 1] += 1
        ms = int(duration)
        if slowest is None or ms > slowest[0] or (ms == slowest[0] and path < slowest[1]):
            slowest = (ms, path)
        counts[path] = counts.get(path, 0) + 1
    out = [f"{index + 1}xx: {count}" for index, count in enumerate(classes)]
    out.append("slowest: -" if slowest is None else f"slowest: {slowest[1]} {slowest[0]}")
    if counts:
        path, count = min(counts.items(), key=lambda item: (-item[1], item[0]))
        out.append(f"top: {path} {count}")
    else:
        out.append("top: -")
    print("\n".join(out))


main()
