import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

// lensmith-native-driver — locates and inspects elements inside ANY running Mac
// app through the public Accessibility API, for Director's native mode
// (CR-LENSMITH-A010-3, design note RN-lensmith-director-native-mode §3).
//
// Part A (CR-LENSMITH-A010-3): serve, trust, prepare, find, hit, focus, press, errors.
// Part B (CR-LENSMITH-A010-4): key, type, settle and tree.
//
// Rules this helper keeps (design note §10):
//   - Public APIs only: ApplicationServices (AXUIElement, AXObserver), AppKit
//     (NSWorkspace, NSRunningApplication, NSScreen), CoreGraphics events, Carbon
//     TIS/UCKeyTranslate. No private AX-to-CGWindowID call.
//   - stdin pipe only, no socket, no sudo.
//   - Only `key` and `type` post input events (keyboard only, CoreGraphics).
//     Visible cursor moves and clicks stay with lensmith-cursor-choreographer.
//   - NO ECHO: no reply, error or log line ever contains typed text. `type`
//     reports only a character count; `emitError` below takes a fixed message
//     and never interpolates request text fields. `tree` never reads values.
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

// MARK: - Event posting seam (part B)
//
// Every keyboard event part B creates goes through `postKeyEvent`, so the
// event-building logic can be exercised without touching the real session.
// LENSMITH_NATIVE_DRIVER_DRY_POST=1 swaps it for a no-op (smoke checks only;
// replies are identical, nothing reaches the HID stream).

var postKeyEvent: (CGEvent) -> Void = { $0.post(tap: .cghidEventTap) }
if ProcessInfo.processInfo.environment["LENSMITH_NATIVE_DRIVER_DRY_POST"] == "1" {
	postKeyEvent = { _ in }
}

let keyEventSource = CGEventSource(stateID: .hidSystemState)

func postKeyStroke(_ keyCode: CGKeyCode, _ flags: CGEventFlags) -> Bool {
	guard let down = CGEvent(keyboardEventSource: keyEventSource, virtualKey: keyCode, keyDown: true),
		let up = CGEvent(keyboardEventSource: keyEventSource, virtualKey: keyCode, keyDown: false)
	else {
		return false
	}
	down.flags = flags
	up.flags = flags
	postKeyEvent(down)
	postKeyEvent(up)
	return true
}

// MARK: - key

/// Copied from src/lib/stepList.ts KEY_NAMES (CR-LENSMITH-A010-2), to kVK_* codes.
let keyCodes: [String: Int] = {
	var map: [String: Int] = [
		"a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
		"f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
		"k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
		"p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
		"u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
		"z": kVK_ANSI_Z,
		"0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
		"5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
		"return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "escape": kVK_Escape,
		"delete": kVK_Delete, "forwarddelete": kVK_ForwardDelete,
		"up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow, "right": kVK_RightArrow,
		"home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
		"minus": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal, "comma": kVK_ANSI_Comma,
		"period": kVK_ANSI_Period, "slash": kVK_ANSI_Slash, "semicolon": kVK_ANSI_Semicolon,
		"quote": kVK_ANSI_Quote, "backslash": kVK_ANSI_Backslash,
		"leftbracket": kVK_ANSI_LeftBracket, "rightbracket": kVK_ANSI_RightBracket,
		"grave": kVK_ANSI_Grave,
	]
	let functionKeys = [
		kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12,
	]
	for (i, code) in functionKeys.enumerated() { map["f\(i + 1)"] = code }
	return map
}()

/// Copied from src/lib/stepList.ts MODIFIER_NAMES.
let modifierFlags: [String: CGEventFlags] = [
	"cmd": .maskCommand, "shift": .maskShift, "opt": .maskAlternate, "ctrl": .maskControl, "fn": .maskSecondaryFn,
]

struct ParsedChord {
	let keyCode: CGKeyCode
	let flags: CGEventFlags
	/// cmd, ctrl or opt: a global hotkey that secure input would swallow.
	let isHotkey: Bool
}

/// Messages name the chord index only, never the request's values.
func parseChords(_ object: [String: Any]) throws -> [ParsedChord] {
	guard let raw = object["chords"] as? [Any], !raw.isEmpty else {
		throw BadRequest(message: "\"chords\" must be a non-empty array.")
	}
	return try raw.enumerated().map { index, item in
		guard let chord = item as? [String: Any], let key = chord["key"] as? String else {
			throw BadRequest(message: "Chord \(index) needs a \"key\" string.")
		}
		guard let code = keyCodes[key] else {
			throw BadRequest(message: "Chord \(index) has an unknown key name.")
		}
		var mods: [String] = []
		if let rawMods = chord["mods"], !(rawMods is NSNull) {
			guard let array = rawMods as? [Any], array.allSatisfy({ $0 is String }) else {
				throw BadRequest(message: "Chord \(index) \"mods\" must be an array of strings.")
			}
			mods = array.map { $0 as! String }
		}
		var flags: CGEventFlags = []
		for mod in mods {
			guard let flag = modifierFlags[mod] else {
				throw BadRequest(message: "Chord \(index) has an unknown modifier name.")
			}
			flags.insert(flag)
		}
		let isHotkey = mods.contains { $0 == "cmd" || $0 == "ctrl" || $0 == "opt" }
		return ParsedChord(keyCode: CGKeyCode(code), flags: flags, isHotkey: isHotkey)
	}
}

func handleKey(_ object: [String: Any]) throws {
	let chords = try parseChords(object)
	guard ensureAccessibilityTrusted(cmd: "key") else { return }
	if chords.contains(where: { $0.isHotkey }) && IsSecureEventInputEnabled() {
		emitError(
			"key", ErrorCode.secureInput,
			"Secure input is on (a password field holds focus somewhere); global hotkeys will not fire.")
		return
	}
	var posted = 0
	for chord in chords {
		guard postKeyStroke(chord.keyCode, chord.flags) else {
			emitError("key", ErrorCode.cannotComplete, "Could not create a keyboard event.", ["posted": posted])
			return
		}
		posted += 1
	}
	emitOk("key", ["posted": posted])
}

// MARK: - type
//
// NO ECHO: nothing in this section writes `text`, a character of it, or the
// request line to stdout or stderr. The reply carries only `count`.

struct KeyStroke {
	let keyCode: CGKeyCode
	let flags: CGEventFlags
}

/// Character → key stroke on the current keyboard layout, built once per process
/// by walking key codes 0..127 under none, shift, option and shift+option.
let layoutMap: [Character: KeyStroke] = buildLayoutMap()

func currentLayoutData() -> CFData? {
	for copy in [TISCopyCurrentKeyboardLayoutInputSource, TISCopyCurrentASCIICapableKeyboardLayoutInputSource] {
		guard let source = copy()?.takeRetainedValue(),
			let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
		else {
			continue
		}
		return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
	}
	return nil
}

func buildLayoutMap() -> [Character: KeyStroke] {
	var map: [Character: KeyStroke] = [:]
	// Fixed keys first, so control characters land on the obvious key.
	map["\n"] = KeyStroke(keyCode: CGKeyCode(kVK_Return), flags: [])
	map["\r"] = KeyStroke(keyCode: CGKeyCode(kVK_Return), flags: [])
	map["\t"] = KeyStroke(keyCode: CGKeyCode(kVK_Tab), flags: [])
	map[" "] = KeyStroke(keyCode: CGKeyCode(kVK_Space), flags: [])
	guard let data = currentLayoutData(), let bytes = CFDataGetBytePtr(data) else { return map }
	let keyboardType = UInt32(LMGetKbdType())
	// UCKeyTranslate takes the Carbon modifier mask shifted right by 8.
	let states: [(UInt32, CGEventFlags)] = [
		(0, []),
		(UInt32(shiftKey >> 8), .maskShift),
		(UInt32(optionKey >> 8), .maskAlternate),
		(UInt32((shiftKey | optionKey) >> 8), [.maskShift, .maskAlternate]),
	]
	bytes.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { layout in
		for (modifierState, flags) in states {
			for keyCode in 0..<128 {
				var deadKeyState: UInt32 = 0
				var length = 0
				var chars = [UniChar](repeating: 0, count: 4)
				let status = UCKeyTranslate(
					layout, UInt16(keyCode), UInt16(kUCKeyActionDown), modifierState, keyboardType,
					OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeyState, chars.count, &length, &chars)
				guard status == noErr, length > 0 else { continue }
				let string = String(utf16CodeUnits: chars, count: length)
				guard string.count == 1, let character = string.first else { continue }
				// Printable characters only; control characters come from the fixed keys above.
				guard character.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
				else {
					continue
				}
				if map[character] == nil {
					map[character] = KeyStroke(keyCode: CGKeyCode(keyCode), flags: flags)
				}
			}
		}
	}
	return map
}

/// One character the layout cannot produce: a single key event carrying the
/// Unicode string (key-down and key-up).
func postUnicodeCharacter(_ character: Character) -> Bool {
	let units = Array(String(character).utf16)
	guard let down = CGEvent(keyboardEventSource: keyEventSource, virtualKey: 0, keyDown: true),
		let up = CGEvent(keyboardEventSource: keyEventSource, virtualKey: 0, keyDown: false)
	else {
		return false
	}
	for event in [down, up] {
		event.flags = []
		units.withUnsafeBufferPointer { buffer in
			event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
		}
	}
	postKeyEvent(down)
	postKeyEvent(up)
	return true
}

let defaultCharDelayMs = 60.0
let maxCharDelayMs = 1000.0

func handleType(_ object: [String: Any]) throws {
	// Type checks only: the message names the field, never its value.
	guard let rawText = object["text"], let text = rawText as? String else {
		throw BadRequest(message: "Missing required string \"text\".")
	}
	let charDelayMs = try numberField(object, "charDelayMs") ?? defaultCharDelayMs
	guard charDelayMs >= 0, charDelayMs <= maxCharDelayMs else {
		throw BadRequest(message: "\"charDelayMs\" must be between 0 and 1000.")
	}
	guard ensureAccessibilityTrusted(cmd: "type") else { return }
	var count = 0
	for character in text {
		if count > 0 && charDelayMs > 0 {
			Thread.sleep(forTimeInterval: charDelayMs / 1000.0)
		}
		let ok: Bool
		if let stroke = layoutMap[character] {
			ok = postKeyStroke(stroke.keyCode, stroke.flags)
		} else {
			ok = postUnicodeCharacter(character)
		}
		guard ok else {
			emitError("type", ErrorCode.cannotComplete, "Could not create a keyboard event.", ["count": count])
			return
		}
		count += 1
	}
	emitOk("type", ["count": count])
}

// MARK: - settle (design note §5, Settle LOCK; values come from timing.ts)

let settleNotifications = [
	kAXCreatedNotification,
	kAXUIElementDestroyedNotification,
	kAXValueChangedNotification,
	kAXTitleChangedNotification,
	kAXFocusedUIElementChangedNotification,
	kAXWindowCreatedNotification,  // re-arms quiet: the native "survives navigation"
	kAXLayoutChangedNotification,
	kAXMenuOpenedNotification,
]

/// Last AX notification time, written by the observer callback on this thread's run loop.
var settleLastNotification = Date()

let settleCallback: AXObserverCallback = { _, _, _, _ in
	settleLastNotification = Date()
}

/// One match attempt of a part A locator (same three branches as `find`).
func locatorMatchesOnce(app: AXUIElement, locator: Locator) -> Bool {
	let roots = scopeRoots(app: app, scope: locator.scope)
	if locator.identifier != nil || locator.hasTextKeys {
		return searchPass(roots: roots, locator: locator).matches.count > locator.index
	}
	if let path = locator.path {
		return roots.first.flatMap { resolvePath(root: $0, path: path) } != nil
	}
	if let point = locator.point, let origin = roots.first.flatMap({ frameOf($0) })?.origin {
		return elementAtGlobal(CGPoint(x: origin.x + point.x, y: origin.y + point.y)) != nil
	}
	return false
}

func handleSettle(_ object: [String: Any]) throws {
	let pid = try requiredPid(object)
	let quietMs = try requiredNumber(object, "quietMs")
	let capMs = try requiredNumber(object, "capMs")
	guard quietMs >= 0, capMs >= 0 else {
		throw BadRequest(message: "\"quietMs\" and \"capMs\" must be non-negative.")
	}
	let expect = try objectField(object, "expect").map { try parseLocator($0) }
	guard ensureAccessibilityTrusted(cmd: "settle") else { return }
	guard runningApp(pid: pid) != nil else {
		emitError("settle", ErrorCode.noApp, "No running app for that pid.", ["pid": Int(pid)])
		return
	}
	let app = appElement(pid: pid)
	var observerRef: AXObserver?
	let created = AXObserverCreate(pid, settleCallback, &observerRef)
	guard created == .success, let observer = observerRef else {
		emitError(
			"settle", ErrorCode.cannotComplete, "Could not create an AX observer.",
			["axError": Int(created.rawValue)])
		return
	}
	var added: [String] = []
	for name in settleNotifications
	where AXObserverAddNotification(observer, app, name as CFString, nil) == .success {
		added.append(name)
	}
	let source = AXObserverGetRunLoopSource(observer)
	let runLoop = CFRunLoopGetCurrent()
	CFRunLoopAddSource(runLoop, source, .defaultMode)

	let start = Date()
	settleLastNotification = start
	var lastExpectCheck = Date.distantPast
	var reason = "cap"
	while true {
		let now = Date()
		if let expect, now.timeIntervalSince(lastExpectCheck) >= pollIntervalSeconds {
			lastExpectCheck = now
			if locatorMatchesOnce(app: app, locator: expect) {
				reason = "expect"
				break
			}
		}
		let afterCheck = Date()
		if afterCheck.timeIntervalSince(settleLastNotification) * 1000 >= quietMs {
			reason = "quiet"
			break
		}
		if afterCheck.timeIntervalSince(start) * 1000 >= capMs {
			reason = "cap"
			break
		}
		_ = CFRunLoopRunInMode(.defaultMode, 0.02, true)
	}
	let settleMs = Int((Date().timeIntervalSince(start) * 1000).rounded())

	for name in added {
		_ = AXObserverRemoveNotification(observer, app, name as CFString)
	}
	CFRunLoopRemoveSource(runLoop, source, .defaultMode)
	emitOk("settle", ["settleMs": settleMs, "reason": reason])
}

// MARK: - tree

let defaultTreeDepth = 12

/// Depth-first, same scopes and limits as `find` (depth ≤40, ≤5000 nodes).
/// `path` is relative to the node's scope root; `root` is that root's index in
/// the scope's search order. `find`'s `path` locator resolves against root 0.
/// No node's value is read, so an AXSecureTextField's contents never leave the app.
func handleTree(_ object: [String: Any]) throws {
	let pid = try requiredPid(object)
	var scope = "app"
	if let wanted = try stringField(object, "in") {
		guard ["app", "window", "menubar", "statusbar"].contains(wanted) else {
			throw BadRequest(message: "\"in\" must be app, window, menubar or statusbar.")
		}
		scope = wanted
	}
	var depthLimit = defaultTreeDepth
	if let depth = try numberField(object, "depth") {
		guard depth >= 0, depth == depth.rounded() else {
			throw BadRequest(message: "\"depth\" must be a non-negative integer.")
		}
		depthLimit = min(Int(depth), maxDepth)
	}
	guard ensureAccessibilityTrusted(cmd: "tree") else { return }
	guard runningApp(pid: pid) != nil else {
		emitError("tree", ErrorCode.noApp, "No running app for that pid.", ["pid": Int(pid)])
		return
	}
	let roots = scopeRoots(app: appElement(pid: pid), scope: scope)
	if roots.isEmpty {
		emitError("tree", ErrorCode.noWindow, "The app has no window or bar in scope \"\(scope)\".", ["pid": Int(pid)])
		return
	}
	var nodes: [[String: Any]] = []
	var truncated = false
	var stack: [(element: AXUIElement, root: Int, path: [Int])] = roots.enumerated().reversed().map {
		($0.element, $0.offset, [])
	}
	while let (element, root, path) = stack.popLast() {
		if nodes.count >= maxNodes {
			truncated = true
			break
		}
		nodes.append([
			"root": root,
			"path": path,
			"role": stringAttribute(element, kAXRoleAttribute),
			"title": stringAttribute(element, kAXTitleAttribute),
			"label": stringAttribute(element, kAXDescriptionAttribute),
			"identifier": stringAttribute(element, kAXIdentifierAttribute),
			"frame": frameJSON(frameOf(element)),
		])
		if path.count < depthLimit {
			let children = elementsAttribute(element, kAXChildrenAttribute)
			for (index, child) in children.enumerated().reversed() {
				stack.append((child, root, path + [index]))
			}
		}
	}
	emitOk("tree", ["nodes": nodes, "truncated": truncated])
}

// MARK: - serve (long-lived, one NDJSON command per line on stdin)

let gatedCommands: Set<String> = ["prepare", "find", "hit", "focus", "press"]

/// Part B (CR-LENSMITH-A010-4): each handler parses, then calls ensureAccessibilityTrusted.
let partBHandlers: [String: ([String: Any]) throws -> Void] = [
	"key": handleKey, "type": handleType, "settle": handleSettle, "tree": handleTree,
]

func dispatch(_ cmd: String, _ object: [String: Any]) {
	if cmd == "trust" {
		handleTrust()
		return
	}
	if let handler = partBHandlers[cmd] {
		// Part B handlers validate the request first, then pass the same trust
		// gate before touching the app or posting any event.
		do {
			try handler(object)
		} catch let error as BadRequest {
			emitError(cmd, ErrorCode.badRequest, error.message)
		} catch {
			emitError(cmd, ErrorCode.cannotComplete, "Unexpected failure.")
		}
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
	writes one JSON reply per line on stdout. Commands: trust, prepare, find, hit,
	focus, press, key, type, settle, tree, quit. Only key and type post (keyboard)
	events; type replies with a character count only.
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
