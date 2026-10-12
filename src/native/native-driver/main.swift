import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

// lensmith-native-driver — locates and inspects elements inside ANY running Mac
// app through the public Accessibility API, for Director's native mode
// (CR-LENSMITH-A010-3, design note RN-lensmith-director-native-mode §3).
//
// Part A (this file): serve, trust, prepare, find, hit, focus, press, errors.
// Part B (CR-LENSMITH-A010-4) adds key, type, settle and tree.
//
// Rules this helper keeps (design note §10):
//   - Public APIs only: ApplicationServices (AXUIElement), AppKit (NSWorkspace,
//     NSRunningApplication, NSScreen). No private AX-to-CGWindowID call.
//   - stdin pipe only, no socket, no sudo.
//   - Part A posts NO input events. Visible cursor moves and clicks stay with
//     lensmith-cursor-choreographer.
//   - NO ECHO: no reply, error or log line ever contains typed text. Part B's
//     `type` command must report only a character count; `emitError` below
//     takes a fixed message and never interpolates request text fields.
//
// Coordinates: every frame is in GLOBAL TOP-LEFT POINTS — the same space the
// cursor helper uses (cursor-choreographer/main.swift, "Coordinate space").
// AX positions are already in that space; NSScreen frames are bottom-left and
// are converted before any comparison.

// MARK: - Constants

enum ErrorCode {
	static let axNotTrusted = "ax_not_trusted"
	static let badRequest = "bad_request"
	static let noApp = "no_app"
	static let noWindow = "no_window"
	static let notFound = "not_found"
	static let staleRef = "stale_ref"
	static let occluded = "occluded"
	static let offscreen = "offscreen"
	static let secureInput = "secure_input"
	static let cannotComplete = "cannot_complete"
}

let maxDepth = 40
let maxNodes = 5000
let pollIntervalSeconds = 0.1
let maxCandidates = 5
/// Per-element AX messaging timeout, so one hung app cannot stall the serve loop
/// for the system default (~6 s) on every attribute read.
let axMessagingTimeoutSeconds: Float = 1.0

// MARK: - Output

func emit(_ fields: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
		let line = String(data: data, encoding: .utf8)
	else {
		return
	}
	print(line)
	fflush(stdout)
}

func emitOk(_ cmd: String, _ fields: [String: Any] = [:]) {
	var out = fields
	out["type"] = "ok"
	out["cmd"] = cmd
	emit(out)
}

/// The single error builder. `message` must be a fixed string or built only from
/// numbers, codes, roles and field NAMES — never from request text values. This
/// is where the no-echo rule is enforced for part B's `type` (design note §10).
func emitError(_ cmd: String, _ code: String, _ message: String, _ extra: [String: Any] = [:]) {
	var out = extra
	out["type"] = "error"
	out["cmd"] = cmd
	out["code"] = code
	out["message"] = message
	emit(out)
}

// MARK: - Request field parsing

struct BadRequest: Error {
	let message: String
}

func isJSONBool(_ value: Any) -> Bool {
	guard let number = value as? NSNumber else { return false }
	return CFGetTypeID(number) == CFBooleanGetTypeID()
}

func numberField(_ object: [String: Any], _ key: String) throws -> Double? {
	guard let raw = object[key], !(raw is NSNull) else { return nil }
	guard let number = raw as? NSNumber, !isJSONBool(raw) else {
		throw BadRequest(message: "\"\(key)\" must be a number.")
	}
	return number.doubleValue
}

func requiredNumber(_ object: [String: Any], _ key: String) throws -> Double {
	guard let value = try numberField(object, key) else {
		throw BadRequest(message: "Missing required number \"\(key)\".")
	}
	return value
}

func requiredPid(_ object: [String: Any]) throws -> pid_t {
	let value = try requiredNumber(object, "pid")
	guard value == value.rounded(), value > 0, value < Double(Int32.max) else {
		throw BadRequest(message: "\"pid\" must be a positive integer.")
	}
	return pid_t(value)
}

func stringField(_ object: [String: Any], _ key: String) throws -> String? {
	guard let raw = object[key], !(raw is NSNull) else { return nil }
	guard let string = raw as? String else {
		throw BadRequest(message: "\"\(key)\" must be a string.")
	}
	return string
}

func objectField(_ object: [String: Any], _ key: String) throws -> [String: Any]? {
	guard let raw = object[key], !(raw is NSNull) else { return nil }
	guard let dict = raw as? [String: Any] else {
		throw BadRequest(message: "\"\(key)\" must be an object.")
	}
	return dict
}

// MARK: - Trust gate

/// Same seam and caching as cursor-choreographer/main.swift ("Accessibility
/// preflight"): checked once per process, never prompts.
var isProcessTrusted: () -> Bool = { AXIsProcessTrusted() }
var accessibilityTrustChecked = false
var accessibilityTrusted = false

func ensureAccessibilityTrusted(cmd: String) -> Bool {
	if !accessibilityTrustChecked {
		accessibilityTrusted = isProcessTrusted()
		accessibilityTrustChecked = true
	}
	if !accessibilityTrusted {
		emitError(
			cmd, ErrorCode.axNotTrusted,
			"Accessibility permission is not granted to this helper. Grant it in System Settings "
				+ "→ Privacy & Security → Accessibility, then restart lensmith-director."
		)
	}
	return accessibilityTrusted
}

// MARK: - AX primitives

func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
	return result == .success ? value : nil
}

func asElement(_ value: CFTypeRef?) -> AXUIElement? {
	guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
	return (value as! AXUIElement)
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
	asElement(copyAttribute(element, name))
}

func elementsAttribute(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
	guard let array = copyAttribute(element, name) as? [AnyObject] else { return [] }
	return array.compactMap { asElement($0) }
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
	guard let value = copyAttribute(element, name) else { return "" }
	if let string = value as? String { return string }
	if let number = value as? NSNumber, !isJSONBool(number) { return number.stringValue }
	return ""
}

func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool? {
	guard let value = copyAttribute(element, name), CFGetTypeID(value) == CFBooleanGetTypeID() else {
		return nil
	}
	return (value as! CFBoolean) == kCFBooleanTrue
}

func pointAttribute(_ element: AXUIElement, _ name: String) -> CGPoint? {
	guard let value = copyAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
		return nil
	}
	var point = CGPoint.zero
	return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

func sizeAttribute(_ element: AXUIElement, _ name: String) -> CGSize? {
	guard let value = copyAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
		return nil
	}
	var size = CGSize.zero
	return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

/// Global top-left points (AX position is already in that space).
func frameOf(_ element: AXUIElement) -> CGRect? {
	guard let origin = pointAttribute(element, kAXPositionAttribute),
		let size = sizeAttribute(element, kAXSizeAttribute)
	else {
		return nil
	}
	return CGRect(origin: origin, size: size)
}

func frameJSON(_ rect: CGRect?) -> Any {
	guard let rect else { return NSNull() }
	return ["x": rect.origin.x, "y": rect.origin.y, "width": rect.size.width, "height": rect.size.height]
}

func pidOf(_ element: AXUIElement) -> pid_t? {
	var pid: pid_t = 0
	return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

/// Every NSScreen frame converted from bottom-left (AppKit) to global top-left.
func screenFramesTopLeft() -> [CGRect] {
	let screens = NSScreen.screens
	guard let primary = screens.first else { return [] }
	let primaryHeight = primary.frame.height
	return screens.map { screen in
		let f = screen.frame
		return CGRect(x: f.origin.x, y: primaryHeight - (f.origin.y + f.height), width: f.width, height: f.height)
	}
}

func isOffscreen(_ rect: CGRect?) -> Bool {
	guard let rect, rect.width > 0 || rect.height > 0 else { return false }
	let screens = screenFramesTopLeft()
	if screens.isEmpty { return false }
	return !screens.contains { $0.intersects(rect) }
}

func appElement(pid: pid_t) -> AXUIElement {
	let app = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(app, axMessagingTimeoutSeconds)
	return app
}

func runningApp(pid: pid_t) -> NSRunningApplication? {
	guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return nil }
	return app
}

// MARK: - Refs (valid until the next find)

var refs: [String: AXUIElement] = [:]
var nextRef = 1

func register(_ element: AXUIElement) -> String {
	let ref = "e\(nextRef)"
	nextRef += 1
	refs[ref] = element
	return ref
}

func clearRefs() {
	refs.removeAll()
}

func elementJSON(_ element: AXUIElement, ref: String? = nil, frame: CGRect? = nil) -> [String: Any] {
	let resolvedFrame = frame ?? frameOf(element)
	return [
		"ref": ref ?? register(element),
		"pid": pidOf(element).map { Int($0) } ?? NSNull(),
		"role": stringAttribute(element, kAXRoleAttribute),
		"title": stringAttribute(element, kAXTitleAttribute),
		"label": stringAttribute(element, kAXDescriptionAttribute),
		"identifier": stringAttribute(element, kAXIdentifierAttribute),
		"enabled": boolAttribute(element, kAXEnabledAttribute) ?? true,
		"frame": frameJSON(resolvedFrame),
	]
}

// MARK: - trust

func handleTrust() {
	emitOk("trust", [
		"accessibility": AXIsProcessTrusted(),
		"secureInput": IsSecureEventInputEnabled(),
	])
}

// MARK: - prepare

func handlePrepare(_ object: [String: Any]) throws {
	let pid = try requiredPid(object)
	let frame = try objectField(object, "frame")
	var target: CGRect?
	if let frame {
		target = CGRect(
			x: try requiredNumber(frame, "x"), y: try requiredNumber(frame, "y"),
			width: try requiredNumber(frame, "width"), height: try requiredNumber(frame, "height")
		)
	}
	guard runningApp(pid: pid) != nil else {
		emitError("prepare", ErrorCode.noApp, "No running app for that pid.", ["pid": Int(pid)])
		return
	}
	let app = appElement(pid: pid)
	// Electron's documented opt-in for its accessibility tree. Errors ignored:
	// native apps simply do not have the attribute.
	_ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)

	guard let target else {
		emitOk("prepare", ["pid": Int(pid)])
		return
	}
	guard let window = elementAttribute(app, kAXMainWindowAttribute) else {
		emitError("prepare", ErrorCode.noWindow, "The app has no main window.", ["pid": Int(pid)])
		return
	}
	var origin = target.origin
	var size = target.size
	if let position = AXValueCreate(.cgPoint, &origin) {
		_ = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position)
	}
	if let sizeValue = AXValueCreate(.cgSize, &size) {
		_ = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
	}
	emitOk("prepare", ["pid": Int(pid), "frame": frameJSON(frameOf(window))])
}

// MARK: - find

struct Locator {
	var identifier: String?
	var role: String?
	var title: String?
	var label: String?
	var value: String?
	var contains = false
	var index = 0
	var scope = "app"
	var path: [Int]?
	var point: CGPoint?

	var hasTextKeys: Bool { role != nil || title != nil || label != nil || value != nil }

	/// Words used to pick near candidates on a miss.
	var words: [String] {
		[identifier, title, label, value].compactMap { $0 }
			.flatMap { $0.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) }
			.map(String.init)
			.filter { !$0.isEmpty }
	}
}

func parseLocator(_ raw: [String: Any]) throws -> Locator {
	var locator = Locator()
	locator.identifier = try stringField(raw, "identifier")
	locator.role = try stringField(raw, "role")
	locator.title = try stringField(raw, "title")
	locator.label = try stringField(raw, "label")
	locator.value = try stringField(raw, "value")
	if let match = try stringField(raw, "match") {
		guard match == "exact" || match == "contains" else {
			throw BadRequest(message: "\"match\" must be \"exact\" or \"contains\".")
		}
		locator.contains = match == "contains"
	}
	if let index = try numberField(raw, "index") {
		guard index >= 0, index == index.rounded() else {
			throw BadRequest(message: "\"index\" must be a non-negative integer.")
		}
		locator.index = Int(index)
	}
	if let scope = try stringField(raw, "in") {
		guard ["app", "window", "menubar", "statusbar"].contains(scope) else {
			throw BadRequest(message: "\"in\" must be app, window, menubar or statusbar.")
		}
		locator.scope = scope
	}
	if let rawPath = raw["path"], !(rawPath is NSNull) {
		guard let array = rawPath as? [Any] else { throw BadRequest(message: "\"path\" must be an array.") }
		locator.path = try array.map { item in
			guard let n = item as? NSNumber, !isJSONBool(item), n.doubleValue >= 0,
				n.doubleValue == n.doubleValue.rounded()
			else {
				throw BadRequest(message: "\"path\" must contain non-negative integers.")
			}
			return n.intValue
		}
	}
	if let point = try objectField(raw, "point") {
		locator.point = CGPoint(x: try requiredNumber(point, "x"), y: try requiredNumber(point, "y"))
	}
	if locator.identifier == nil && !locator.hasTextKeys && locator.path == nil && locator.point == nil {
		throw BadRequest(message: "A locator needs at least one of identifier, role, title, label, value, path or point.")
	}
	return locator
}

/// Scope roots, in search order (design note §2 "in").
func scopeRoots(app: AXUIElement, scope: String) -> [AXUIElement] {
	switch scope {
	case "window":
		return elementAttribute(app, kAXFocusedWindowAttribute).map { [$0] } ?? []
	case "menubar":
		return elementAttribute(app, kAXMenuBarAttribute).map { [$0] } ?? []
	case "statusbar":
		return elementAttribute(app, "AXExtrasMenuBar").map { [$0] } ?? []
	default:
		var roots: [AXUIElement] = []
		let focused = elementAttribute(app, kAXFocusedWindowAttribute)
		if let focused { roots.append(focused) }
		for window in elementsAttribute(app, kAXWindowsAttribute)
		where focused == nil || !CFEqual(window, focused!) {
			roots.append(window)
		}
		if let menuBar = elementAttribute(app, kAXMenuBarAttribute) { roots.append(menuBar) }
		return roots
	}
}

func textMatches(_ actual: String, _ wanted: String?, contains: Bool) -> Bool {
	guard let wanted else { return true }
	return contains ? actual.localizedCaseInsensitiveContains(wanted) : actual == wanted
}

func nodeMatches(_ node: AXUIElement, _ locator: Locator) -> Bool {
	if let identifier = locator.identifier {
		return stringAttribute(node, kAXIdentifierAttribute) == identifier
	}
	if let role = locator.role, stringAttribute(node, kAXRoleAttribute) != role { return false }
	return textMatches(stringAttribute(node, kAXTitleAttribute), locator.title, contains: locator.contains)
		&& textMatches(stringAttribute(node, kAXDescriptionAttribute), locator.label, contains: locator.contains)
		&& textMatches(stringAttribute(node, kAXValueAttribute), locator.value, contains: locator.contains)
}

func isCandidate(_ node: AXUIElement, _ locator: Locator, words: [String]) -> Bool {
	let role = stringAttribute(node, kAXRoleAttribute)
	if let wantedRole = locator.role, role == wantedRole { return true }
	if words.isEmpty { return false }
	let haystack = (stringAttribute(node, kAXTitleAttribute) + " "
		+ stringAttribute(node, kAXDescriptionAttribute)).lowercased()
	return words.contains { haystack.contains($0) }
}

/// One breadth-first pass over the scope roots: depth <= 40, <= 5000 nodes.
func searchPass(roots: [AXUIElement], locator: Locator) -> (matches: [AXUIElement], candidates: [AXUIElement]) {
	var matches: [AXUIElement] = []
	var candidates: [AXUIElement] = []
	let words = locator.words
	var visited = 0
	var queue: [(AXUIElement, Int)] = roots.map { ($0, 0) }
	var head = 0
	while head < queue.count && visited < maxNodes {
		let (node, depth) = queue[head]
		head += 1
		visited += 1
		if nodeMatches(node, locator) {
			matches.append(node)
			if matches.count > locator.index { break }
		} else if candidates.count < maxCandidates && isCandidate(node, locator, words: words) {
			candidates.append(node)
		}
		if depth < maxDepth {
			for child in elementsAttribute(node, kAXChildrenAttribute) {
				queue.append((child, depth + 1))
			}
		}
	}
	return (matches, candidates)
}

func resolvePath(root: AXUIElement, path: [Int]) -> AXUIElement? {
	var node = root
	for index in path {
		let children = elementsAttribute(node, kAXChildrenAttribute)
		guard index < children.count else { return nil }
		node = children[index]
	}
	return node
}

func elementAtGlobal(_ point: CGPoint) -> AXUIElement? {
	let systemWide = AXUIElementCreateSystemWide()
	AXUIElementSetMessagingTimeout(systemWide, axMessagingTimeoutSeconds)
	var element: AXUIElement?
	let result = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element)
	return result == .success ? element : nil
}

/// Emits the found element, or `offscreen` when its frame is outside every screen.
func emitFound(_ cmd: String, _ element: AXUIElement) {
	let frame = frameOf(element)
	let json = elementJSON(element, frame: frame)
	if isOffscreen(frame) {
		emitError(cmd, ErrorCode.offscreen, "The element's frame is outside every screen.", ["element": json])
		return
	}
	emitOk(cmd, ["element": json])
}

func handleFind(_ object: [String: Any]) throws {
	let pid = try requiredPid(object)
	guard let rawLocator = try objectField(object, "locator") else {
		throw BadRequest(message: "Missing required object \"locator\".")
	}
	let locator = try parseLocator(rawLocator)
	let timeoutMs = max(0, try numberField(object, "timeoutMs") ?? 0)

	clearRefs()
	guard runningApp(pid: pid) != nil else {
		emitError("find", ErrorCode.noApp, "No running app for that pid.", ["pid": Int(pid)])
		return
	}
	let app = appElement(pid: pid)
	let deadline = Date().addingTimeInterval(timeoutMs / 1000.0)
	var lastCandidates: [AXUIElement] = []
	var sawRoot = false

	while true {
		let roots = scopeRoots(app: app, scope: locator.scope)
		if !roots.isEmpty { sawRoot = true }

		if locator.identifier != nil || locator.hasTextKeys {
			let pass = searchPass(roots: roots, locator: locator)
			if pass.matches.count > locator.index {
				emitFound("find", pass.matches[locator.index])
				return
			}
			lastCandidates = pass.candidates
		} else if let path = locator.path {
			if let root = roots.first, let node = resolvePath(root: root, path: path) {
				emitFound("find", node)
				return
			}
		} else if let point = locator.point {
			// Window-relative points, converted to global through the first root's frame.
			if let root = roots.first, let origin = frameOf(root)?.origin,
				let node = elementAtGlobal(CGPoint(x: origin.x + point.x, y: origin.y + point.y))
			{
				emitFound("find", node)
				return
			}
		}

		if Date() >= deadline { break }
		Thread.sleep(forTimeInterval: pollIntervalSeconds)
	}

	if !sawRoot {
		emitError(
			"find", ErrorCode.noWindow, "The app has no window or bar in scope \"\(locator.scope)\".",
			["pid": Int(pid)])
		return
	}
	emitError(
		"find", ErrorCode.notFound, "No element matched the locator.",
		["candidates": lastCandidates.prefix(maxCandidates).map { elementJSON($0) }])
}

// MARK: - hit

/// The TS side compares the returned pid with the target app's pid to raise
/// `occluded` (CR-LENSMITH-A010-5).
func handleHit(_ object: [String: Any]) throws {
	let x = try requiredNumber(object, "x")
	let y = try requiredNumber(object, "y")
	guard let element = elementAtGlobal(CGPoint(x: x, y: y)) else {
		emitError("hit", ErrorCode.notFound, "No accessible element at that point.", ["x": x, "y": y])
		return
	}
	let json = elementJSON(element)
	emitOk("hit", ["element": json, "pid": json["pid"] ?? NSNull()])
}

// MARK: - focus / press
//
// PRE-ROLL ONLY, NEVER ON CAMERA: these act through AX without moving the real
// cursor, so a viewer would see a control change with nothing driving it.
// On-camera clicks go through lensmith-cursor-choreographer.

func refElement(_ cmd: String, _ object: [String: Any]) throws -> AXUIElement? {
	guard let ref = try stringField(object, "ref") else {
		throw BadRequest(message: "Missing required string \"ref\".")
	}
	guard let element = refs[ref] else {
		emitError(cmd, ErrorCode.staleRef, "Unknown or expired ref; refs last until the next find.")
		return nil
	}
	return element
}

func handleFocus(_ object: [String: Any]) throws {
	guard let element = try refElement("focus", object) else { return }
	let result = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	if result == .success {
		emitOk("focus")
	} else {
		emitError("focus", ErrorCode.cannotComplete, "Setting focus failed.", ["axError": Int(result.rawValue)])
	}
}

func handlePress(_ object: [String: Any]) throws {
	guard let element = try refElement("press", object) else { return }
	let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
	if result == .success {
		emitOk("press")
	} else {
		emitError("press", ErrorCode.cannotComplete, "The press action failed.", ["axError": Int(result.rawValue)])
	}
}

// MARK: - serve (long-lived, one NDJSON command per line on stdin)

let gatedCommands: Set<String> = ["prepare", "find", "hit", "focus", "press"]

func dispatch(_ cmd: String, _ object: [String: Any]) {
	if cmd == "trust" {
		handleTrust()
		return
	}
	guard gatedCommands.contains(cmd) else {
		// Fixed message: the command name is not echoed (it is request text).
		emitError(cmd.count <= 32 ? cmd : "?", ErrorCode.badRequest, "Unknown command.")
		return
	}
	guard ensureAccessibilityTrusted(cmd: cmd) else { return }
	do {
		switch cmd {
		case "prepare": try handlePrepare(object)
		case "find": try handleFind(object)
		case "hit": try handleHit(object)
		case "focus": try handleFocus(object)
		case "press": try handlePress(object)
		default: break
		}
	} catch let error as BadRequest {
		emitError(cmd, ErrorCode.badRequest, error.message)
	} catch {
		emitError(cmd, ErrorCode.cannotComplete, "Unexpected failure.")
	}
}

func serve() {
	emit(["type": "ready"])
	while let line = readLine(strippingNewline: true) {
		let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { continue }
		guard let data = trimmed.data(using: .utf8),
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			let cmd = object["cmd"] as? String
		else {
			emitError("?", ErrorCode.badRequest, "Malformed command line; expected a JSON object with a \"cmd\" string.")
			continue
		}
		if cmd == "quit" {
			emitOk("quit")
			return
		}
		dispatch(cmd, object)
	}
}

// MARK: - Entry point

let usage = """
	lensmith-native-driver — locates and inspects elements in any Mac app via Accessibility.

	Usage:
	  lensmith-native-driver serve

	`serve` prints {"type":"ready"}, then reads one JSON command per line on stdin and
	writes one JSON reply per line on stdout. Commands (part A): trust, prepare, find,
	hit, focus, press, quit. Part A posts no input events.
	"""

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "serve":
	serve()
case "-h", "--help", "help":
	print(usage)
default:
	FileHandle.standardError.write(Data((usage + "\n").utf8))
	exit(2)
}
