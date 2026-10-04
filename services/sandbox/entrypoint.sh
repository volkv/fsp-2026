#!/bin/sh
# Prepares the container for go-judge and replaces itself with it. Runs as root with CAP_SYS_ADMIN, which exists only
# for this and for go-judge's own namespaces and mounts (see docs/development.md, "Песочница").
set -eu

cgroup=/sys/fs/cgroup

# Docker gives the container a private cgroup namespace mounted read-only. go-judge limits every program through
# cgroup v2, so the mount is made writable; the namespace root is the container's own cgroup, whose limits (memory,
# CPU, pids from compose.yaml) are set outside it and stay out of reach.
if [ "$(stat -f -c %T "$cgroup")" != cgroup2fs ]; then
	echo "sandbox: cgroup v2 is required at $cgroup" >&2
	exit 1
fi
if ! grep -q " $cgroup rw," /proc/self/mountinfo; then
	mount -o remount,rw "$cgroup"
fi

# A cgroup with processes cannot hand controllers to its children, so this process (the only one in the container
# at start) moves to a leaf first. go-judge keeps that leaf and nests the program cgroups next to itself.
mkdir -p "$cgroup/judge"
echo $$ > "$cgroup/judge/cgroup.procs"
for controller in cpu memory pids; do
	if ! grep -qw "$controller" "$cgroup/cgroup.controllers"; then
		echo "sandbox: cgroup controller $controller is not delegated to the container" >&2
		exit 1
	fi
	echo "+$controller" > "$cgroup/cgroup.subtree_control"
done

# Programs get a fresh procfs inside their user namespace. The kernel allows that only while a procfs without
# overmounts is visible, and Docker masks parts of /proc; a separate read-only instance satisfies the check without
# unmasking the container's own /proc.
mkdir -p /run/sandbox/proc
mountpoint -q /run/sandbox/proc || mount -t proc -o ro,nosuid,nodev,noexec proc /run/sandbox/proc

# The system call filter of the programs (seccomp.yaml) comes before the command's flags, so a command given by the
# deployment keeps it. go-judge runs programs without a filter when the file is missing, so its absence stops here.
filter=/etc/sandbox/seccomp.yaml
if [ ! -r "$filter" ]; then
	echo "sandbox: program system call filter $filter is missing" >&2
	exit 1
fi

# go-judge does not reset supplementary groups of programs, and the root group would be mapped into every user
# namespace; it runs without supplementary groups instead.
exec setpriv --clear-groups /usr/local/sbin/go-judge "-seccomp-conf=$filter" "$@"
