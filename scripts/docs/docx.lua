-- DOCX only. A page break before every top-level section, as the print style does for the PDF. A table of contents of
-- levels 1–2 written out in full instead of pandoc's empty TOC field: Word refreshes the field with page numbers when
-- the document is opened, and editors that do not refresh fields still show the entries as links to the sections.
-- Section numbers repeat --number-sections: unnumbered headings are skipped and do not advance the count.

local function escape(text)
	return (text:gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('"', '&quot;'))
end

local function toc(blocks)
	local counters = {}
	local entries = {}
	for _, block in ipairs(blocks) do
		if block.t == 'Header' and not block.classes:includes('unnumbered') then
			counters[block.level] = (counters[block.level] or 0) + 1
			for deeper = block.level + 1, #counters do
				counters[deeper] = nil
			end
			if block.level <= 2 then
				local number = {}
				for level = 1, block.level do
					number[level] = tostring(counters[level] or 0)
				end
				if block.identifier == '' then
					error('heading without an identifier: ' .. pandoc.utils.stringify(block.content))
				end
				entries[#entries + 1] = {
					level = block.level,
					anchor = block.identifier,
					text = table.concat(number, '.') .. ' ' .. pandoc.utils.stringify(block.content)
				}
			end
		end
	end
	if #entries == 0 then
		error('the document has no headings for the table of contents')
	end
	local paragraphs = {
		'<w:p><w:pPr><w:pStyle w:val="TOCHeading" /></w:pPr><w:r><w:t>Содержание</w:t></w:r></w:p>'
	}
	for index, entry in ipairs(entries) do
		local field_start = index == 1
				and '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true" /></w:r>'
					.. '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r>'
					.. '<w:r><w:fldChar w:fldCharType="separate" /></w:r>'
			or ''
		local field_end = index == #entries and '<w:r><w:fldChar w:fldCharType="end" /></w:r>' or ''
		paragraphs[#paragraphs + 1] = ('<w:p><w:pPr><w:pStyle w:val="TOC%d" /></w:pPr>%s'
			.. '<w:hyperlink w:anchor="%s" w:history="1"><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:hyperlink>%s</w:p>'):format(
			entry.level,
			field_start,
			escape(entry.anchor),
			escape(entry.text),
			field_end
		)
	end
	return pandoc.RawBlock('openxml', table.concat(paragraphs))
end

-- Text area of the reference document (docx-reference.lua) is 9741 twips wide; images are at most 220 mm tall, as in
-- the print style, so a tall diagram stays on one page. pandoc itself only fits images to the width.
local MAX_WIDTH_IN = 9741 / 1440
local MAX_HEIGHT_IN = 220 / 25.4

function Image(image)
	local file = assert(io.open(image.src, 'rb'))
	local size = pandoc.image.size(file:read('a'), PANDOC_WRITER_OPTIONS)
	file:close()
	local width_in, height_in = size.width / size.dpi_horz, size.height / size.dpi_vert
	local scale = math.min(1, MAX_WIDTH_IN / width_in, MAX_HEIGHT_IN / height_in)
	image.attributes.width = ('%.2fin'):format(width_in * scale)
	image.attributes.height = nil
	return image
end

function Pandoc(doc)
	local blocks = { toc(doc.blocks) }
	for _, block in ipairs(doc.blocks) do
		if block.t == 'Header' and block.level == 1 then
			blocks[#blocks + 1] = pandoc.RawBlock('openxml', '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
		end
		blocks[#blocks + 1] = block
	end
	doc.blocks = blocks
	return doc
end
