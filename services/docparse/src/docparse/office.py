"""RTF, DOC and ODT: converted to DOCX by LibreOffice headless, then read like any DOCX.

Each conversion gets a fresh LibreOffice profile in the request's scratch directory. The profile turns on
`BlockUntrustedRefererLinks`: without it LibreOffice fetches linked images of a document during conversion,
which is an outgoing request chosen by whoever wrote the file. The container network is the second barrier.
"""

from __future__ import annotations

import re
from pathlib import Path

from docparse.context import ParseContext
from docparse.errors import ErrorCode, ParseFailure
from docparse.tools import run_tool

_PROFILE_SETTINGS = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
  </item>
</oor:items>
"""


def convert_to_docx(source: Path, ctx: ParseContext) -> Path:
    profile = ctx.workdir / "lo-profile"
    (profile / "user").mkdir(parents=True)
    (profile / "user" / "registrymodifications.xcu").write_text(_PROFILE_SETTINGS, encoding="utf-8")
    outdir = ctx.workdir / "converted"
    outdir.mkdir()
    run_tool(
        [
            "soffice",
            f"-env:UserInstallation={profile.as_uri()}",
            "--headless",
            "--invisible",
            "--nodefault",
            "--nologo",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            "docx:MS Word 2007 XML",
            "--outdir",
            str(outdir),
            str(source),
        ],
        memory_mb=ctx.limits.converter_memory_mb,
        env=ctx.tool_env(),
        cwd=ctx.workdir,
        failure="Document could not be converted",
    )
    converted = outdir / f"{source.stem}.docx"
    if not converted.is_file():
        # LibreOffice exits with 0 even when it cannot load the input.
        raise ParseFailure(ErrorCode.CORRUPT, "Document could not be converted")
    return converted


# RTF fields and objects that pull content from another location.
_RTF_EXTERNAL = re.compile(rb"INCLUDEPICTURE|INCLUDETEXT|\\objautlink|\\objlink|\\\*\\linkval", re.IGNORECASE)
# ODF links whose target is outside the package: package members are relative paths without a scheme or "..".
_ODF_EXTERNAL = re.compile(rb"""xlink:href\s*=\s*["'](?:[a-z][a-z0-9+.-]*:|/|\\\\|\.\.)""", re.IGNORECASE)
_ODF_LINK_ELEMENTS = re.compile(
    rb"<(?:draw:image|draw:object|draw:object-ole|draw:plugin|draw:applet|text:section-source|office:dde-source)\b[^>]*>",
    re.IGNORECASE,
)


def rtf_references_external(data: bytes) -> bool:
    return _RTF_EXTERNAL.search(data) is not None


def odf_references_external(xml: bytes) -> bool:
    return any(_ODF_EXTERNAL.search(tag.group(0)) for tag in _ODF_LINK_ELEMENTS.finditer(xml))
