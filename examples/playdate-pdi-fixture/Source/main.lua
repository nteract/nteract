import "CoreLibs/graphics"

local gfx = playdate.graphics
local assetPath = "assets/cloud-figure"
local copiedPath = "downloaded/cloud-figure"
local didAutotest = false
local displayImage, displayError = gfx.image.new(assetPath)

local function readAutotestFlag()
	local file = playdate.file.open("autotest.flag")
	if file == nil then
		return nil
	end
	local value = file:readline()
	file:close()
	return value
end

local function writeTelemetry(metrics)
	local lines = {}
	lines[#lines + 1] = "AUTOTEST name=playdate-pdi-fixture"
	for key, value in pairs(metrics) do
		lines[#lines + 1] = "AUTOTEST " .. tostring(key) .. "=" .. tostring(value)
	end
	table.sort(lines)
	for _, line in ipairs(lines) do
		print(line)
	end

	local file = playdate.file.open("autotest-result.txt", playdate.file.kFileWrite)
	if file ~= nil then
		for _, line in ipairs(lines) do
			file:write(line .. "\n")
		end
		file:flush()
		file:close()
	end
end

local function copyFile(sourcePath, destinationPath)
	local source, sourceError = playdate.file.open(sourcePath, playdate.file.kFileRead)
	if source == nil then
		return false, 0, sourceError or "open source failed"
	end
	local destination, destinationError = playdate.file.open(destinationPath, playdate.file.kFileWrite)
	if destination == nil then
		source:close()
		return false, 0, destinationError or "open destination failed"
	end

	local total = 0
	while true do
		local chunk = source:read(4096)
		if chunk == nil or #chunk == 0 then
			break
		end
		destination:write(chunk)
		total = total + #chunk
	end
	destination:flush()
	destination:close()
	source:close()
	return true, total, nil
end

local function runAutotest()
	local metrics = {
		bundled_pdi_exists = tostring(playdate.file.exists(assetPath .. ".pdi")),
		bundled_load = "false",
		copied_load = "false",
		datastore_read = "false",
	}

	local bundled, bundledError = gfx.image.new(assetPath)
	if bundled ~= nil then
		local width, height = bundled:getSize()
		metrics.bundled_load = "true"
		metrics.width = tostring(width)
		metrics.height = tostring(height)
	else
		metrics.bundled_error = bundledError or "nil image"
	end

	playdate.file.delete("downloaded", true)
	playdate.file.mkdir("downloaded")
	local copied, byteLength, copyError = copyFile(assetPath .. ".pdi", copiedPath .. ".pdi")
	metrics.copy_to_data = tostring(copied)
	metrics.byte_length = tostring(byteLength)
	if copyError ~= nil then
		metrics.copy_error = copyError
	end

	local copiedImage, copiedError = gfx.image.new(copiedPath)
	if copiedImage ~= nil then
		metrics.copied_load = "true"
	else
		metrics.copied_error = copiedError or "nil image"
	end

	local datastoreImage, datastoreError = playdate.datastore.readImage(copiedPath)
	if datastoreImage ~= nil then
		metrics.datastore_read = "true"
	else
		metrics.datastore_error = datastoreError or "nil image"
	end

	if metrics.bundled_load == "true" and metrics.copied_load == "true" and metrics.datastore_read == "true" then
		metrics.result = "PASS"
	else
		metrics.result = "FAIL"
	end
	writeTelemetry(metrics)
end

function playdate.update()
	if readAutotestFlag() ~= nil and not didAutotest then
		didAutotest = true
		runAutotest()
	end

	gfx.clear(gfx.kColorWhite)
	gfx.setColor(gfx.kColorBlack)
	if displayImage ~= nil then
		displayImage:draw(136, 56)
		gfx.drawText("PDI load fixture", 144, 152)
	else
		gfx.drawText("Image load failed", 126, 104)
		gfx.drawText(displayError or "unknown error", 40, 128)
	end
end
