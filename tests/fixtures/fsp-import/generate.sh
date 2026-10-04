#!/bin/sh
# Regenerates results.xlsx from results.csv and the protocols (*.pdf, protocol.docx) from their *.html with LibreOffice
# (soffice in PATH). protocol-teams: a ruled team protocol over two pages; protocol-tasks: an individual protocol with a
# grid of tasks (a verdict and a time in each cell) and its header repeated on every page; protocol.docx: the same
# protocol as protocol.pdf, kept as a native DOCX table.
# The people and teams in the fixtures are fictional.
set -eu
cd "$(dirname "$0")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# CSV import: «;», UTF-8, header on line 1; FSP ID and EKP number as text, the start date as a date (DD.MM.YYYY).
soffice -env:UserInstallation="file://$WORK/profile" --headless --infilter='CSV:59,34,76,1,1/2/5/2/10/4' \
	--convert-to xlsx --outdir "$WORK" results.csv >/dev/null
soffice -env:UserInstallation="file://$WORK/profile" --headless \
	--infilter="HTML (StarWriter)" --convert-to pdf:writer_pdf_Export --outdir "$WORK" \
	protocol.html protocol-v2.html protocol-teams.html protocol-tasks.html >/dev/null
soffice -env:UserInstallation="file://$WORK/profile" --headless \
	--infilter="HTML (StarWriter)" --convert-to docx --outdir "$WORK" protocol.html >/dev/null
cp "$WORK/results.xlsx" "$WORK/protocol.pdf" "$WORK/protocol-v2.pdf" "$WORK/protocol-teams.pdf" "$WORK/protocol-tasks.pdf" \
	"$WORK/protocol.docx" .
