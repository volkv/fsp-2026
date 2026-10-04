package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"unicode"
)

func main() {
	reader := bufio.NewReaderSize(os.Stdin, 1<<16)
	var k int
	if _, err := fmt.Fscanln(reader, &k); err != nil {
		panic(err)
	}
	text, err := io.ReadAll(reader)
	if err != nil {
		panic(err)
	}

	counts := make(map[string]int)
	var word strings.Builder
	flush := func() {
		if word.Len() > 0 {
			counts[word.String()]++
			word.Reset()
		}
	}
	for _, r := range string(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			word.WriteRune(unicode.ToLower(r))
		} else {
			flush()
		}
	}
	flush()

	words := make([]string, 0, len(counts))
	for w := range counts {
		words = append(words, w)
	}
	sort.Slice(words, func(i, j int) bool {
		if counts[words[i]] != counts[words[j]] {
			return counts[words[i]] > counts[words[j]]
		}
		return words[i] < words[j]
	})
	if len(words) > k {
		words = words[:k]
	}
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for _, w := range words {
		fmt.Fprintf(out, "%s %d\n", w, counts[w])
	}
}
