import sys
from bisect import bisect_left


def main() -> None:
    data = sys.stdin.buffer.read().split()
    n, q = int(data[0]), int(data[1])
    position = 2
    bookings: dict[bytes, list[tuple[int, int]]] = {}
    for _ in range(n):
        room, start, end = data[position], int(data[position + 1]), int(data[position + 2])
        position += 3
        bookings.setdefault(room, []).append((start, end))

    merged: dict[bytes, tuple[list[int], list[int]]] = {}
    for room, intervals in bookings.items():
        intervals.sort()
        starts: list[int] = []
        ends: list[int] = []
        for start, end in intervals:
            if ends and start <= ends[-1]:
                if end > ends[-1]:
                    ends[-1] = end
            else:
                starts.append(start)
                ends.append(end)
        merged[room] = (starts, ends)

    out: list[str] = []
    for _ in range(q):
        room, begin, finish = data[position], int(data[position + 1]), int(data[position + 2])
        position += 3
        found = merged.get(room)
        busy = False
        if found is not None:
            starts, ends = found
            index = bisect_left(starts, finish) - 1
            busy = index >= 0 and ends[index] > begin
        out.append("BUSY" if busy else "FREE")

    for room in sorted(merged):
        starts, ends = merged[room]
        total = sum(end - start for start, end in zip(starts, ends))
        out.append(f"{room.decode()} {total}")
    sys.stdout.write("\n".join(out) + "\n")


main()
