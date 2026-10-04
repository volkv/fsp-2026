import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class Main {
	private static final class Student {
		final String name;
		long sum;
		long count;

		Student(String name) {
			this.name = name;
		}
	}

	private static String average(long sum, long count) {
		return BigDecimal.valueOf(sum).divide(BigDecimal.valueOf(count), 2, RoundingMode.HALF_UP).toPlainString();
	}

	public static void main(String[] args) throws IOException {
		BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		int n = Integer.parseInt(in.readLine().trim());
		Map<String, Student> students = new HashMap<>();
		long totalSum = 0;
		for (int i = 0; i < n; i++) {
			String line = in.readLine();
			int first = line.indexOf(';');
			int last = line.lastIndexOf(';');
			String name = line.substring(0, first);
			int grade = Integer.parseInt(line.substring(last + 1).trim());
			Student student = students.computeIfAbsent(name, Student::new);
			student.sum += grade;
			student.count++;
			totalSum += grade;
		}
		List<Student> ordered = new ArrayList<>(students.values());
		ordered.sort((a, b) -> {
			int byAverage = Long.compare(b.sum * a.count, a.sum * b.count);
			return byAverage != 0 ? byAverage : a.name.compareTo(b.name);
		});
		PrintWriter out = new PrintWriter(System.out, false, StandardCharsets.UTF_8);
		for (Student student : ordered) {
			out.println(student.name + ": " + average(student.sum, student.count) + " (" + student.count + ")");
		}
		out.println("total: " + average(totalSum, n) + " (" + n + ")");
		out.flush();
	}
}
