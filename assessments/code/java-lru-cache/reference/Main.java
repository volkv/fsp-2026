import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class Main {
	private record Entry(String value, long expiresAt) {}

	/** Access-ordered: iteration goes from the least to the most recently used entry. */
	private static final LinkedHashMap<String, Entry> cache = new LinkedHashMap<>(16, 0.75f, true);

	private static void purgeExpired(long now) {
		cache.values().removeIf(entry -> entry.expiresAt() <= now);
	}

	public static void main(String[] args) throws IOException {
		BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		String[] head = in.readLine().trim().split("\\s+");
		int capacity = Integer.parseInt(head[0]);
		int n = Integer.parseInt(head[1]);
		PrintWriter out = new PrintWriter(System.out, false, StandardCharsets.UTF_8);
		long now = 0;
		for (int i = 0; i < n; i++) {
			String[] op = in.readLine().trim().split("\\s+");
			now = Long.parseLong(op[1]);
			purgeExpired(now);
			String key = op[2];
			switch (op[0]) {
				case "PUT" -> {
					Entry entry = new Entry(op[3], now + Long.parseLong(op[4]));
					if (!cache.containsKey(key) && cache.size() == capacity) {
						Iterator<String> eldest = cache.keySet().iterator();
						out.println("EVICT " + eldest.next());
						eldest.remove();
					}
					cache.put(key, entry);
				}
				case "GET" -> {
					Entry entry = cache.get(key);
					out.println(entry == null ? "MISS" : entry.value());
				}
				case "DEL" -> out.println(cache.remove(key) == null ? "MISS" : "OK");
				default -> throw new IllegalArgumentException("unknown operation " + op[0]);
			}
		}
		purgeExpired(now);
		List<String> keys = new ArrayList<>(cache.keySet());
		Collections.reverse(keys);
		out.println("SIZE " + keys.size());
		out.println("KEYS " + (keys.isEmpty() ? "-" : String.join(" ", keys)));
		out.flush();
	}
}
