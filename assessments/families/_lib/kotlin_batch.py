"""Compiles and runs a batch of Kotlin programs with the Kotlin compiler and the JVM of the sandbox image.

Reads JSON from standard input: {"programs": [str], "workers": int, "seconds": float}; writes JSON to standard output:
[{"stdout": str, "error": str | null}], one result per program, in order.

Each program is a whole `Main.kt` with `fun main()`. It is compiled in its own package (`package p<i>` is put on top, so
top-level declarations of different programs never clash), the programs are split into `workers` groups, and every
group is compiled by one compiler invocation — one start of the compiler for hundreds of programs instead of one per
program. A program that does not compile gets the compiler's error and leaves its group, and the group is compiled
again. Then one JVM per group runs the `main` of each program in turn, in a thread of its own, with the standard output
captured; a program that does not finish in `seconds` ends that JVM, and the rest of the group runs in a new one.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

JAVA = "/usr/local/lib/jvm/temurin-21/bin/java"
KOTLIN = "/usr/local/lib/kotlin"
LIB = KOTLIN + "/lib"
RUNTIME = f"{LIB}/kotlin-stdlib.jar:{LIB}/kotlinx-coroutines-core-jvm.jar"
JVM = [JAVA, "-XX:+UseSerialGC", "-XX:-UsePerfData", "-Xss64m"]

RUNNER = r'''
package batchrunner

import java.io.ByteArrayOutputStream
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.PrintStream
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield

fun quote(s: String): String = buildString {
    append('"')
    for (c in s) {
        when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c == '\n' -> append("\\n")
            c == '\r' -> append("\\r")
            c == '\t' -> append("\\t")
            c < ' ' -> append(String.format("\\u%04x", c.code))
            else -> append(c)
        }
    }
    append('"')
}

// Loads the classes of the standard library and of the coroutines before the first program: a program whose order of
// events depends on delays must not pay for class loading between two of its own steps.
fun warmUp() {
    val sink = PrintStream(ByteArrayOutputStream(), true, "UTF-8")
    System.setOut(sink)
    runBlocking {
        val channel = Channel<Int>(1)
        val state = MutableStateFlow(0)
        val job = launch { delay(1); yield(); channel.send(1); state.value = 1 }
        val deferred = async { flow { emit(1); emit(2) }.map { it * 2 }.toList() }
        println(channel.receive() + deferred.await().sum() + state.value)
        job.join()
        withTimeoutOrNull(1) { delay(5) }
        supervisorScope { coroutineScope { launch { println(listOf(1, 2).map { it.toString() }.joinToString()) } } }
        println(mapOf("a" to 1).entries.sortedBy { it.key }.asSequence().filter { it.value > 0 }.toList())
        println(String.format("%d %s", 1, "x") + buildString { append(1.5) })
    }
}

fun main(args: Array<String>) {
    val millis = args[0].toLong()
    val out = PrintStream(FileOutputStream(FileDescriptor.out), true, "UTF-8")
    warmUp()
    for (id in args.drop(1)) {
        val buffer = ByteArrayOutputStream()
        val captured = PrintStream(buffer, true, "UTF-8")
        System.setOut(captured)
        val error = AtomicReference<String?>(null)
        val thread = Thread {
            try {
                Class.forName("p$id.MainKt").getMethod("main", Array<String>::class.java).invoke(null, arrayOf<String>())
            } catch (e: InvocationTargetException) {
                val cause = e.cause ?: e
                error.set("${cause.javaClass.name}: ${cause.message}")
            } catch (e: Throwable) {
                error.set("${e.javaClass.name}: ${e.message}")
            }
        }
        thread.start()
        thread.join(millis)
        captured.flush()
        val text = buffer.toString("UTF-8")
        if (thread.isAlive) {
            out.println("{\"id\":$id,\"stdout\":${quote(text)},\"error\":\"timeout\"}")
            out.flush()
            Runtime.getRuntime().halt(3)
        }
        val e = error.get()
        out.println("{\"id\":$id,\"stdout\":${quote(text)},\"error\":${if (e == null) "null" else quote(e)}}")
    }
    out.flush()
    Runtime.getRuntime().halt(0)
}
'''

ERROR_LINE = re.compile(r"p(\d+)/Main\.kt:\d+:\d+: error: (.*)")


def compile_group(work, ids, programs):
    """Compiles the programs of a group into `work/out`; returns {id: compiler error} of those that do not compile."""
    failed = {}
    left = list(ids)
    while left:
        out = os.path.join(work, "out")
        subprocess.run(["rm", "-rf", out], check=True)
        files = [os.path.join(work, "src", f"p{i}", "Main.kt") for i in left] + [os.path.join(work, "src", "Runner.kt")]
        done = subprocess.run(
            JVM
            + [
                "-XX:TieredStopAtLevel=1",
                "-Xmx1g",
                f"-Dkotlin.home={KOTLIN}",
                "-cp",
                f"{LIB}/kotlin-preloader.jar",
                "org.jetbrains.kotlin.preloading.Preloader",
                "-cp",
                f"{LIB}/kotlin-compiler.jar",
                "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
                "-no-stdlib",
                "-no-reflect",
                "-cp",
                RUNTIME,
                "-jvm-target",
                "21",
                "-nowarn",
                "-d",
                out,
            ]
            + files,
            capture_output=True,
            text=True,
        )
        if done.returncode == 0:
            return failed
        broken = {}
        for match in ERROR_LINE.finditer(done.stderr):
            broken.setdefault(int(match.group(1)), match.group(0))
        if not broken or not set(broken) <= set(left):
            raise RuntimeError(f"kotlinc failed outside the programs: {done.stderr[-2000:]}")
        failed.update({i: f"compile error: {broken[i]}" for i in broken})
        left = [i for i in left if i not in broken]
    return failed


def run_group(work, ids, seconds):
    results = {}
    left = list(ids)
    while left:
        done = subprocess.run(
            JVM
            + ["-XX:TieredStopAtLevel=1", "-Xmx512m", "-cp", f"{work}/out:{RUNTIME}", "batchrunner.RunnerKt"]
            + [str(int(seconds * 1000))]
            + [str(i) for i in left],
            capture_output=True,
            text=True,
            timeout=seconds * len(left) + 60,
        )
        for line in done.stdout.splitlines():
            if line.startswith("{"):
                record = json.loads(line)
                results[record["id"]] = {"stdout": record["stdout"], "error": record["error"]}
        if done.returncode not in (0, 3):
            raise RuntimeError(f"the runner exited with {done.returncode}: {done.stderr[-2000:]}")
        left = [i for i in left if i not in results]
    return results


def run_batch(programs, workers, seconds):
    with tempfile.TemporaryDirectory() as root:
        groups = [list(range(g, len(programs), workers)) for g in range(workers)]
        groups = [g for g in groups if g]

        def work_on(g):
            ids = groups[g]
            work = os.path.join(root, f"g{g}")
            for i in ids:
                os.makedirs(os.path.join(work, "src", f"p{i}"))
                with open(os.path.join(work, "src", f"p{i}", "Main.kt"), "w", encoding="utf-8") as f:
                    f.write(f"package p{i}\n" + programs[i])
            with open(os.path.join(work, "src", "Runner.kt"), "w", encoding="utf-8") as f:
                f.write(RUNNER)
            failed = compile_group(work, ids, programs)
            results = {i: {"stdout": "", "error": failed[i]} for i in failed}
            compiled = [i for i in ids if i not in failed]
            if compiled:
                results.update(run_group(work, compiled, seconds))
            return results

        merged = {}
        with ThreadPoolExecutor(max_workers=len(groups) or 1) as pool:
            for results in pool.map(work_on, range(len(groups))):
                merged.update(results)
        return [merged[i] for i in range(len(programs))]


def main():
    request = json.load(sys.stdin)
    results = run_batch(request["programs"], max(1, int(request["workers"])), float(request["seconds"]))
    sys.stdout.write(json.dumps(results))


if __name__ == "__main__":
    main()
