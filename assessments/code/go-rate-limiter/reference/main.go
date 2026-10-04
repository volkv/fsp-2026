package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

type tariff struct {
	capacity int64
	period   int64
}

type bucket struct {
	tariff  tariff
	tokens  int64
	mark    int64
	allowed int
	denied  int
}

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<16)
	out := bufio.NewWriterSize(os.Stdout, 1<<16)
	defer out.Flush()

	var fallback tariff
	fmt.Fscan(in, &fallback.capacity, &fallback.period)
	var m int
	fmt.Fscan(in, &m)
	tariffs := make(map[string]tariff, m)
	for i := 0; i < m; i++ {
		var name string
		var t tariff
		fmt.Fscan(in, &name, &t.capacity, &t.period)
		tariffs[name] = t
	}

	var n int
	fmt.Fscan(in, &n)
	buckets := make(map[string]*bucket)
	for i := 0; i < n; i++ {
		var at int64
		var name string
		fmt.Fscan(in, &at, &name)
		b, ok := buckets[name]
		if !ok {
			t, custom := tariffs[name]
			if !custom {
				t = fallback
			}
			b = &bucket{tariff: t, tokens: t.capacity, mark: at}
			buckets[name] = b
		}
		if b.tokens == b.tariff.capacity {
			b.mark = at
		} else {
			gained := (at - b.mark) / b.tariff.period
			if b.tokens+gained >= b.tariff.capacity {
				b.tokens = b.tariff.capacity
				b.mark = at
			} else {
				b.tokens += gained
				b.mark += gained * b.tariff.period
			}
		}
		if b.tokens > 0 {
			b.tokens--
			b.allowed++
			fmt.Fprintln(out, "ALLOW")
		} else {
			b.denied++
			fmt.Fprintln(out, "DENY")
		}
	}

	names := make([]string, 0, len(buckets))
	for name := range buckets {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		b := buckets[name]
		fmt.Fprintf(out, "%s %d %d\n", name, b.allowed, b.denied)
	}
}
