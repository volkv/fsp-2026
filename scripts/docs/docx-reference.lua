-- Builds the reference DOCX the documentation is written with: pandoc's default reference (arg[1]) with an A4 page,
-- the PDF's margins, page numbers in the footer, 11 pt text, compact ruled tables and styles for the table of contents
-- (docx.lua fills it). Run as `pandoc lua docx-reference.lua <default reference.docx> <output.docx>`.
local input, output = arg[1], arg[2]
if input == nil or output == nil then
	error('usage: pandoc lua docx-reference.lua <default reference.docx> <output.docx>')
end

local W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

--- Replaces the single match of the Lua pattern `pattern` in `text`; any other number of matches is an error, so a
--- change in pandoc's default reference cannot silently leave a style unpatched.
local function replace_one(text, pattern, replacement, what)
	local result, count = text:gsub(pattern, function()
		return replacement
	end)
	if count ~= 1 then
		error(('reference.docx: expected one %s, found %d'):format(what, count))
	end
	return result
end

local DOC_DEFAULTS = [[<w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi" />
        <w:sz w:val="22" />
        <w:szCs w:val="22" />
        <w:lang w:val="ru-RU" w:eastAsia="zh-CN" w:bidi="ar-SA" />
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="160" />
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>]]

-- Text in tables is 9 pt: the paragraph styles inside cells set no size, so the table style's size applies.
local RULE = 'w:val="single" w:sz="4" w:space="0" w:color="C9CED6"'
local TABLE_STYLE = ([[<w:style w:type="table" w:default="1" w:styleId="Table">
    <w:name w:val="Table" />
    <w:basedOn w:val="TableNormal" />
    <w:qFormat />
    <w:rPr>
      <w:sz w:val="18" />
      <w:szCs w:val="18" />
    </w:rPr>
    <w:tblPr>
      <w:tblInd w:type="dxa" w:w="0" />
      <w:tblBorders>
        <w:top %s />
        <w:bottom %s />
        <w:insideH %s />
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:type="dxa" w:w="40" />
        <w:left w:type="dxa" w:w="85" />
        <w:bottom w:type="dxa" w:w="40" />
        <w:right w:type="dxa" w:w="85" />
      </w:tblCellMar>
    </w:tblPr>
    <w:tblStylePr w:type="firstRow">
      <w:rPr>
        <w:b />
      </w:rPr>
      <w:tcPr>
        <w:tcBorders>
          <w:bottom w:val="single" w:sz="8" w:space="0" w:color="5B6270" />
        </w:tcBorders>
        <w:shd w:val="clear" w:color="auto" w:fill="F1F3F6" />
        <w:vAlign w:val="bottom" />
      </w:tcPr>
    </w:tblStylePr>
  </w:style>]]):format(RULE, RULE, RULE)

local VERBATIM_STYLE = [[<w:style w:type="character" w:customStyle="1" w:styleId="VerbatimChar">
    <w:name w:val="Verbatim Char" />
    <w:basedOn w:val="BodyTextChar" />
    <w:rPr>
      <w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" />
      <w:sz w:val="19" />
    </w:rPr>
  </w:style>]]

local TOC_STYLES = [[<w:style w:type="paragraph" w:styleId="TOC1">
    <w:name w:val="toc 1" />
    <w:basedOn w:val="Normal" />
    <w:next w:val="Normal" />
    <w:uiPriority w:val="39" />
    <w:unhideWhenUsed />
    <w:pPr>
      <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9741" /></w:tabs>
      <w:spacing w:before="120" w:after="40" />
    </w:pPr>
    <w:rPr>
      <w:b />
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="TOC2">
    <w:name w:val="toc 2" />
    <w:basedOn w:val="Normal" />
    <w:next w:val="Normal" />
    <w:uiPriority w:val="39" />
    <w:unhideWhenUsed />
    <w:pPr>
      <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9741" /></w:tabs>
      <w:spacing w:after="20" />
      <w:ind w:left="397" />
    </w:pPr>
  </w:style>
</w:styles>]]

-- A4, margins as in the PDF (top 18 mm, bottom 20 mm, left 20 mm, right 18 mm): 9741 twips of text width.
local SECTION = [[<w:sectPr>
      <w:footerReference w:type="default" r:id="rIdPageFooter" />
      <w:footnotePr>
        <w:numRestart w:val="eachSect" />
      </w:footnotePr>
      <w:pgSz w:w="11906" w:h="16838" />
      <w:pgMar w:top="1021" w:right="1021" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0" />
    </w:sectPr>]]

local function field(instruction)
	return '<w:r><w:fldChar w:fldCharType="begin" /></w:r>'
		.. ('<w:r><w:instrText xml:space="preserve"> %s </w:instrText></w:r>'):format(instruction)
		.. '<w:r><w:fldChar w:fldCharType="separate" /></w:r><w:r><w:t>1</w:t></w:r>'
		.. '<w:r><w:fldChar w:fldCharType="end" /></w:r>'
end

local FOOTER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
	.. ('<w:ftr %s>'):format(W)
	.. '<w:p><w:pPr><w:jc w:val="center" /><w:rPr><w:color w:val="5B6270" /><w:sz w:val="16" /></w:rPr></w:pPr>'
	.. field('PAGE')
	.. '<w:r><w:t xml:space="preserve"> / </w:t></w:r>'
	.. field('NUMPAGES')
	.. '</w:p></w:ftr>'

local archive = pandoc.zip.Archive(assert(io.open(input, 'rb')):read('a'))
local entries = {}
for _, entry in ipairs(archive.entries) do
	local text = entry:contents()
	if entry.path == 'word/styles.xml' then
		text = replace_one(text, '<w:docDefaults>.-</w:docDefaults>', DOC_DEFAULTS, 'docDefaults')
		text = replace_one(text, '<w:style w:type="table" w:default="1" w:styleId="Table">.-</w:style>', TABLE_STYLE, 'Table style')
		text = replace_one(
			text,
			'<w:style w:type="character" w:customStyle="1" w:styleId="VerbatimChar">.-</w:style>',
			VERBATIM_STYLE,
			'VerbatimChar style'
		)
		text = replace_one(text, '</w:styles>', TOC_STYLES, 'end of styles')
	elseif entry.path == 'word/document.xml' then
		text = replace_one(text, '<w:sectPr>.-</w:sectPr>', SECTION, 'section properties')
	elseif entry.path == 'word/_rels/document.xml.rels' then
		text = replace_one(
			text,
			'</Relationships>',
			'<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" '
				.. 'Id="rIdPageFooter" Target="footer1.xml" /></Relationships>',
			'end of relationships'
		)
	elseif entry.path == '[Content_Types].xml' then
		text = replace_one(
			text,
			'</Types>',
			'<Override PartName="/word/footer1.xml" '
				.. 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" /></Types>',
			'end of content types'
		)
	end
	entries[#entries + 1] = pandoc.zip.Entry(entry.path, text, entry.modtime)
end
entries[#entries + 1] = pandoc.zip.Entry('word/footer1.xml', FOOTER, 0)

local out = assert(io.open(output, 'wb'))
out:write(pandoc.zip.Archive(entries):bytestring())
out:close()
