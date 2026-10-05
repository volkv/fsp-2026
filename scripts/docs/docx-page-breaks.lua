-- DOCX only: a page break before every top-level section, as the print style does for the PDF.
function Header(header)
	if header.level == 1 then
		return { pandoc.RawBlock('openxml', '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'), header }
	end
end
