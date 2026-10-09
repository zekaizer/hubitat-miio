/**
 * Mi Fan - Hubitat driver for Xiaomi fans over the local miio protocol (UDP 54321), no cloud.
 *
 * Supported models, detected with miIO.info:
 *   zhimi.fan.za1  - legacy dialect (get_prop / set_*)
 *   dmaker.fan.p33 - miot dialect (get_properties / set_properties)
 *
 * Both models are exposed identically. The measured device behaviour this driver relies on is
 * recorded in docs/local-api.md.
 *
 * Copyright 2026 Luke Lee
 * Licensed under the Apache License, Version 2.0
 */

import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import groovy.transform.Field
import hubitat.helper.HexUtils
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

// moveSteps: move steps from one end of the range to the other. Counted by eye as 22 and 27;
// the fans do not report the end of the range.
@Field static final Map<String, Map> MODELS = [
    "zhimi.fan.za1" : [dialect: "legacy", angles: [30, 60, 90, 120], moveSteps: 24],
    "dmaker.fan.p33": [dialect: "miot", angles: [30, 60, 90, 120, 140], moveSteps: 28]
]
@Field static final List<String> LEGACY_PROPS = [
    "power", "speed_level", "angle_enable", "angle", "mode", "buzzer", "led_b", "child_lock"
]
// [siid, piid]. level is 2/6: the spec calls it a read-only status, the device accepts 1-100.
@Field static final Map<String, List<Integer>> MIOT_PROPS = [
    power: [2, 1], level: [2, 6], oscillation: [2, 4], angle: [2, 5], mode: [2, 3],
    buzzer: [5, 1], light: [4, 1], lock: [7, 1]
]
@Field static final List<String> SPEEDS = ["low", "medium-low", "medium", "high"]
@Field static final List<String> ENFORCED = ["buzzer", "light", "lock"]
@Field static final Map<String, String> SETTING_TYPES = [
    ip: "text", token: "password", pollSeconds: "number", nightModes: "text", logEnable: "bool", moveSwitches: "bool",
    buzzerDay: "enum", lightDay: "enum", lockDay: "enum", buzzerNight: "enum", lightNight: "enum", lockNight: "enum"
]
@Field static final String DRIVER_NAME = "Mi Fan"
// Child switches, key to name suffix. The move switches exist only while the preference is set.
@Field static final Map<String, String> CHILDREN = [
    "oscillation": "Oscillation", "move-left": "Move Left", "move-right": "Move Right"
]
@Field static final String HELLO = "21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
@Field static final int PORT = 54321
// zhimi.fan.za1 drops a packet whose stamp is 60 s stale and still accepts 30 s.
@Field static final int HANDSHAKE_TTL_MS = 20000
// Longer than the 4 s the devices take to answer "user ack timeout".
@Field static final int REPLY_TIMEOUT_S = 6
@Field static final int MAX_RETRIES = 2
@Field static final int ENFORCE_INTERVAL_MS = 10000
// A jog sends the next step this long after the reply to the previous one. Not shorter:
// dmaker.fan.p33 answers a step sent 200 ms after the last reply with code 0 and skips it.
@Field static final int JOG_INTERVAL_MS = 400

metadata {
    definition(name: "Mi Fan", namespace: "zekaizer", author: "Luke Lee", singleThreaded: true,
               importUrl: "https://raw.githubusercontent.com/zekaizer/hubitat-mifan/main/drivers/mi-fan.groovy") {
        capability "Actuator"
        capability "Switch"
        capability "SwitchLevel"
        capability "FanControl"
        capability "Refresh"
        capability "Initialize"

        attribute "oscillation", "enum", ["on", "off"]
        attribute "oscillationAngle", "number"
        attribute "windMode", "enum", ["normal", "natural"]
        attribute "nightMode", "enum", ["on", "off"]
        attribute "connection", "string"

        command "setOscillation", [[name: "state", type: "ENUM", constraints: ["on", "off"]]]
        command "setOscillationAngle", [[name: "angle", type: "NUMBER"]]
        command "setWindMode", [[name: "mode", type: "ENUM", constraints: ["normal", "natural"]]]
        // Turns the head one step.
        command "move", [[name: "direction", type: "ENUM", constraints: ["left", "right"]]]
        // Sets preferences from a JSON object, so a script can configure the device without the UI.
        command "configureDevice", [[name: "settings", type: "STRING"]]
    }

    preferences {
        input name: "ip", type: "text", title: "Fan IP address", required: true
        input name: "token", type: "password", title: "Device token (32 hex characters)", required: true
        input name: "pollSeconds", type: "number", title: "Poll interval (seconds)", defaultValue: 30
        input name: "buzzerDay", type: "enum", title: "Buzzer", options: ["unmanaged", "on", "off"], defaultValue: "unmanaged",
            description: "The driver keeps the fan at this value. unmanaged: leave it alone."
        input name: "lightDay", type: "enum", title: "Indicator light", options: ["unmanaged", "on", "off"], defaultValue: "unmanaged"
        input name: "lockDay", type: "enum", title: "Child lock", options: ["unmanaged", "on", "off"], defaultValue: "unmanaged"
        input name: "nightModes", type: "text", title: "Hub modes treated as night (comma separated)", defaultValue: "Night"
        input name: "buzzerNight", type: "enum", title: "Buzzer at night", options: ["same", "on", "off"], defaultValue: "same"
        input name: "lightNight", type: "enum", title: "Indicator light at night", options: ["same", "on", "off"], defaultValue: "same"
        input name: "lockNight", type: "enum", title: "Child lock at night", options: ["same", "on", "off"], defaultValue: "same"
        input name: "moveSwitches", type: "bool", title: "Create left and right move switches", defaultValue: false,
            description: "The head keeps turning while a switch is on and stops when it is turned off."
        input name: "logEnable", type: "bool", title: "Enable debug logging", defaultValue: false
    }
}

def installed() {
    sendEvent(name: "supportedFanSpeeds", value: JsonOutput.toJson(SPEEDS + ["on", "off"]))
    sendEvent(name: "connection", value: "unconfigured")
}

def updated() {
    initialize()
}

def initialize() {
    unschedule()
    state.clear()
    state.queue = []
    sendEvent(name: "supportedFanSpeeds", value: JsonOutput.toJson(SPEEDS + ["on", "off"]))
    if (!settings.ip || !settings.token) {
        sendEvent(name: "connection", value: "unconfigured")
        return
    }
    ensureChildren()
    refresh()
}

def configureDevice(String json) {
    Map values = new JsonSlurper().parseText(json) as Map
    values.each { key, value ->
        String type = SETTING_TYPES[key.toString()]
        if (type) {
            device.updateSetting(key.toString(), [value: value, type: type])
        } else {
            log.warn "configureDevice: unknown setting ${key}"
        }
    }
    runIn(1, "initialize")
}

// ---- commands ----

def refresh() {
    // Until the model is known nothing else can be sent in the right dialect.
    if (profile()) {
        // A read between two steps of a jog would make the steps uneven.
        if (!state.jog) {
            poll()
        }
    } else if (!queued("info")) {
        enqueue("miIO.info", [], "info")
    }
    Integer every = (settings.pollSeconds ?: 30) as Integer
    if (every > 0) {
        runIn(every, "refresh")
    }
}

def on() {
    setPower(true)
}

def off() {
    setPower(false)
}

def setLevel(level, duration = null) {
    if (!ready()) {
        return
    }
    Integer value = Math.min(100, level as Integer)
    if (value <= 0) {
        off()
        return
    }
    Boolean isOn = device.currentValue("switch") == "on"
    publish([power: true, level: value])
    if (isMiot()) {
        // Power first: the device ignores a level written before the power in the same request.
        miotSet(isOn ? [level: value] : [power: true, level: value])
    } else {
        if (!isOn) {
            // set_speed_level answers device_poweroff while the fan is off.
            enqueue("set_power", ["on"], "set")
        }
        // set_speed_level leaves natural mode; set_natural_level keeps it.
        Boolean natural = device.currentValue("windMode") == "natural"
        enqueue(natural ? "set_natural_level" : "set_speed_level", [value], "set")
    }
}

def setSpeed(String speed) {
    switch (speed) {
        case "off": off(); break
        case "on": on(); break
        case "low": setLevel(25); break
        case "medium-low": setLevel(50); break
        case "medium": setLevel(75); break
        case "high": setLevel(100); break
        default: log.warn "unsupported speed ${speed}"
    }
}

def cycleSpeed() {
    Integer next = (SPEEDS.indexOf(device.currentValue("speed")) + 1) % SPEEDS.size()
    setSpeed(SPEEDS[next])
}

def setOscillation(String value) {
    if (!requireOn("setOscillation")) {
        // The switch was not changed, but whoever asked may already show the new value.
        childSwitch("oscillation", device.currentValue("oscillation") == "on", true)
        return
    }
    Boolean enable = value == "on"
    publish([oscillation: enable])
    if (isMiot()) {
        miotSet([oscillation: enable])
    } else {
        // Any value other than "on" turns the swing off without an error.
        enqueue("set_angle_enable", [enable ? "on" : "off"], "set")
    }
}

def setOscillationAngle(angle) {
    if (!requireOn("setOscillationAngle")) {
        return
    }
    Integer value = angle as Integer
    if (!(value in profile().angles)) {
        log.warn "unsupported angle ${value}; supported: ${profile().angles}"
        return
    }
    publish([angle: value, oscillation: true])
    if (isMiot()) {
        // Swing is turned on as well, because set_angle does that on the legacy model.
        miotSet([angle: value, oscillation: true])
    } else {
        enqueue("set_angle", [value], "set")
    }
}

def setWindMode(String mode) {
    if (!requireOn("setWindMode")) {
        return
    }
    if (!(mode in ["normal", "natural"])) {
        log.warn "unsupported wind mode ${mode}"
        return
    }
    publish([mode: mode])
    if (isMiot()) {
        miotSet([mode: mode])
    } else {
        enqueue("set_mode", [mode], "set")
    }
}

def move(String direction) {
    if (!requireOn("move")) {
        return
    }
    if (!(direction in ["left", "right"])) {
        log.warn "unsupported direction ${direction}"
        return
    }
    stopOscillation()
    enqueueMove(direction)
}

void componentOn(cd) {
    String key = childKey(cd)
    if (key == "oscillation") {
        setOscillation("on")
    } else {
        startJog(key - "move-")
    }
}

void componentOff(cd) {
    String key = childKey(cd)
    if (key == "oscillation") {
        setOscillation("off")
    } else if (state.jog?.direction == key - "move-") {
        endJog()
        resumePolling()
    } else {
        childSwitch(key, false)
    }
}

void componentRefresh(cd) {
    poll()
}

private void setPower(Boolean value) {
    if (!ready()) {
        return
    }
    if (!value && state.jog) {
        endJog()
    }
    publish([power: value])
    if (isMiot()) {
        miotSet([power: value])
    } else {
        // Only the lowercase strings are accepted.
        enqueue("set_power", [value ? "on" : "off"], "set")
    }
}

private Boolean ready() {
    if (!profile()) {
        log.warn "command ignored: the fan model is not known yet (connection: ${device.currentValue('connection')})"
        return false
    }
    return true
}

// Both models are made to refuse these while off; only the legacy one does so by itself.
private Boolean requireOn(String command) {
    if (!ready()) {
        return false
    }
    if (device.currentValue("switch") != "on") {
        log.warn "${command} ignored: the fan is off"
        return false
    }
    return true
}

private Map profile() {
    return MODELS[state.model as String]
}

private Boolean isMiot() {
    return profile()?.dialect == "miot"
}

private void poll() {
    if (queued("poll")) {
        return
    }
    if (isMiot()) {
        enqueue("get_properties", MIOT_PROPS.collect { String name, List<Integer> id -> [did: name, siid: id[0], piid: id[1]] }, "poll")
    } else {
        enqueue("get_prop", LEGACY_PROPS, "poll")
    }
}

private void miotSet(Map values) {
    List params = values.collect { key, value ->
        List<Integer> id = MIOT_PROPS[key.toString()]
        // Booleans must be JSON booleans: the device takes any string as false.
        [did: key.toString(), siid: id[0], piid: id[1], value: key == "mode" ? (value == "natural" ? 1 : 0) : value]
    }
    enqueue("set_properties", params, "set")
}

// ---- move: one step per request, repeated while a move switch is on ----

private void startJog(String direction) {
    if (!requireOn("move")) {
        childSwitch("move-${direction}", false, true)
        return
    }
    if (state.jog) {
        endJog()
    }
    stopOscillation()
    state.jog = [direction: direction, steps: 0]
    childSwitch("move-${direction}", true)
    jogStep()
}

// Runs JOG_INTERVAL_MS after the reply to the previous step. The next step is never queued
// ahead, so turning the switch off stops the head after at most the step already sent.
def jogStep() {
    Map jog = state.jog
    if (!jog) {
        return
    }
    // The head is at the end of the range by now: a move switch left on turns itself off.
    if ((jog.steps as Integer) >= (profile().moveSteps as Integer)) {
        endJog()
        resumePolling()
        return
    }
    jog.steps = (jog.steps as Integer) + 1
    state.jog = jog
    enqueueMove(jog.direction as String)
}

private void endJog() {
    String direction = state.jog?.direction
    state.remove("jog")
    unschedule("jogStep")
    state.queue = (state.queue ?: []).findAll { it.kind != "move" }
    if (direction) {
        childSwitch("move-${direction}", false)
    }
}

// The reply to a step still in flight reads the state back by itself.
private void resumePolling() {
    if (!queued("move")) {
        poll()
    }
}

// zhimi.fan.za1 answers device_busy to a move while it swings.
private void stopOscillation() {
    if (device.currentValue("oscillation") == "on") {
        setOscillation("off")
    }
}

private void enqueueMove(String direction) {
    if (isMiot()) {
        enqueue("set_properties", [[did: "move", siid: 6, piid: 1, value: direction == "left" ? 1 : 2]], "move")
    } else {
        enqueue("set_move", [direction], "move")
    }
}

// ---- kept settings and night mode ----

private Boolean isNight() {
    List<String> names = (settings.nightModes ?: "").toString().split(",").collect { it.trim().toLowerCase() }.findAll { it }
    return names.contains(location.mode?.toString()?.toLowerCase())
}

private void enforce(Map current, Boolean night) {
    Map wanted = [:]
    ENFORCED.each { String key ->
        String pref = settings[key + "Day"]
        String atNight = settings[key + "Night"]
        if (night && atNight in ["on", "off"]) {
            pref = atNight
        }
        if (pref in ["on", "off"] && current[key] != (pref == "on")) {
            wanted[key] = (pref == "on")
        }
    }
    // A fan that does not take the value must not be written to on every reply.
    if (!wanted || now() - ((state.enforcedAt ?: 0) as Long) < ENFORCE_INTERVAL_MS) {
        return
    }
    state.enforcedAt = now()
    log.info "restoring kept settings: ${wanted}"
    if (isMiot()) {
        miotSet(wanted)
        return
    }
    wanted.each { key, value ->
        switch (key) {
            // Value meanings follow python-miio (buzzer 2 = on; led_b 0 = bright, 2 = off); not verified by eye.
            case "buzzer": enqueue("set_buzzer", [value ? 2 : 0], "set"); break
            case "light": enqueue("set_led_b", [value ? 0 : 2], "set"); break
            case "lock": enqueue("set_child_lock", [value ? "on" : "off"], "set"); break
        }
    }
}

// ---- request queue: one request in flight, the next is sent when its reply arrives ----

private Boolean queued(String kind) {
    return (state.queue ?: []).any { it.kind == kind } || state.inflight?.kind == kind
}

private void enqueue(String method, List params, String kind) {
    List queue = state.queue ?: []
    queue << [method: method, params: params, kind: kind, tries: 0]
    state.queue = queue
    pump()
}

private void pump() {
    if (state.inflight || state.awaitingHello || !state.queue) {
        return
    }
    if (now() - ((state.handshakeAt ?: 0) as Long) > HANDSHAKE_TTL_MS) {
        state.awaitingHello = true
        sendHex(HELLO)
        runIn(REPLY_TIMEOUT_S, "onTimeout")
        return
    }
    List queue = state.queue
    Map item = queue.remove(0)
    state.queue = queue
    // Message id 0 is never answered.
    Integer id = (((state.msgId ?: 0) as Integer) % 9999) + 1
    state.msgId = id
    item.id = id
    state.inflight = item
    sendHex(buildPacket(JsonOutput.toJson([id: id, method: item.method, params: item.params])))
    runIn(REPLY_TIMEOUT_S, "onTimeout")
}

// A dropped packet, a wrong token and an absent fan all look the same: no reply.
def onTimeout() {
    Map item = state.inflight
    state.inflight = null
    state.awaitingHello = false
    state.remove("handshakeAt")
    if (item?.kind == "move") {
        // A step is relative: sent again after a lost reply it could turn the head twice.
        item = null
        endJog()
    }
    List queue = state.queue ?: []
    Integer failures = ((state.failures ?: 0) as Integer) + 1
    if (failures > MAX_RETRIES) {
        log.warn "no reply from ${settings.ip}; dropping ${queue.size() + (item ? 1 : 0)} request(s)"
        endJog()
        state.queue = []
        state.failures = 0
        sendEvent(name: "connection", value: "offline")
        return
    }
    state.failures = failures
    if (item) {
        // Every write is an absolute value, so sending it twice is harmless.
        queue.add(0, item)
    }
    state.queue = queue
    pump()
}

private void sendHex(String hex) {
    sendHubCommand(new hubitat.device.HubAction(hex, hubitat.device.Protocol.LAN, [
        type: hubitat.device.HubAction.Type.LAN_TYPE_UDPCLIENT,
        destinationAddress: "${settings.ip}:${PORT}",
        encoding: hubitat.device.HubAction.Encoding.HEX_STRING,
        timeout: REPLY_TIMEOUT_S
    ]))
}

private String buildPacket(String json) {
    String payload = HexUtils.byteArrayToHexString(crypt(Cipher.ENCRYPT_MODE, json.getBytes("UTF-8")))
    Long stamp = (state.deviceStamp as Long) + ((now() - (state.handshakeAt as Long)) / 1000 as Long)
    String header = "2131" + String.format("%04x", 32 + (payload.length() / 2 as Integer)) + "00000000" +
        state.deviceId + String.format("%08x", stamp)
    String checksum = HexUtils.byteArrayToHexString(md5(HexUtils.hexStringToByteArray(header + settings.token + payload)))
    return (header + checksum + payload).toLowerCase()
}

private byte[] crypt(int mode, byte[] data) {
    byte[] key = md5(HexUtils.hexStringToByteArray(settings.token))
    // iv = md5(key + token); concatenated as hex because the sandbox has no System.arraycopy.
    byte[] iv = md5(HexUtils.hexStringToByteArray(HexUtils.byteArrayToHexString(key) + settings.token))
    Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
    cipher.init(mode, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv))
    return cipher.doFinal(data)
}

private byte[] md5(byte[] data) {
    return MessageDigest.getInstance("MD5").digest(data)
}

// ---- replies ----

def parse(String description) {
    String hex = parseLanMessage(description)?.payload
    if (!hex || hex.length() < 64) {
        return
    }
    if (hex.length() == 64) {
        // Handshake reply: 32-byte header carrying the device id and its clock.
        state.deviceId = hex.substring(16, 24)
        state.deviceStamp = Long.parseLong(hex.substring(24, 32), 16)
        state.handshakeAt = now()
        state.awaitingHello = false
        unschedule("onTimeout")
        pump()
        return
    }
    Map reply
    try {
        String text = new String(crypt(Cipher.DECRYPT_MODE, HexUtils.hexStringToByteArray(hex.substring(64))), "UTF-8")
        // The device pads the JSON with NUL bytes.
        reply = new JsonSlurper().parseText(text.replaceAll("\u0000", "").trim()) as Map
    } catch (Exception e) {
        log.warn "cannot read a reply from ${settings.ip}: ${e.message}"
        return
    }
    Map item = state.inflight
    if (!item || (reply.id as Integer) != (item.id as Integer)) {
        return
    }
    unschedule("onTimeout")
    state.inflight = null
    state.failures = 0
    handle(item, reply)
    pump()
}

private void handle(Map item, Map reply) {
    // The miIO.info result contains the device token, so it is never logged.
    if (logEnable && item.kind != "info") {
        log.debug "${item.method} ${item.params} -> ${reply.result ?: reply.error}"
    }
    if (reply.error) {
        log.warn "${item.method} ${item.kind == 'set' ? item.params : ''} failed: ${reply.error.code} ${reply.error.message}"
    }
    switch (item.kind) {
        case "info":
            if (reply.result) {
                applyInfo(reply.result as Map)
            }
            break
        case "poll":
            // Read before a queued write: it would undo the state reported for that write.
            if (reply.result && !queued("set")) {
                applyState(isMiot() ? decodeMiot(reply.result as List) : decodeLegacy(reply.result as List))
            }
            break
        case "set":
            rejected(reply)
            // A set reply carries no state. Read it back once the last queued write is done.
            if (!queued("set") && !state.jog) {
                poll()
            }
            break
        case "move":
            if ((reply.error || rejected(reply)) && state.jog) {
                endJog()
            }
            if (state.jog) {
                runInMillis(JOG_INTERVAL_MS, "jogStep")
            } else {
                resumePolling()
            }
            break
    }
}

// miot answers each item with its own code. Returns whether any item was refused.
private Boolean rejected(Map reply) {
    List refused = reply.result instanceof List ? reply.result.findAll { it instanceof Map && it.code != 0 } : []
    refused.each { log.warn "${it.did} rejected: code ${it.code}" }
    return !refused.isEmpty()
}

private void applyInfo(Map info) {
    String model = info.model
    state.model = model
    device.updateDataValue("model", model)
    device.updateDataValue("firmware", info.fw_ver as String)
    applyDefaultName(info.mac as String)
    if (!MODELS[model]) {
        log.warn "unsupported model ${model}"
        sendEvent(name: "connection", value: "unsupported model")
        return
    }
    poll()
}

private Map decodeLegacy(List values) {
    if (values?.size() != LEGACY_PROPS.size()) {
        return null
    }
    Map p = [:]
    LEGACY_PROPS.eachWithIndex { String name, int i -> p[name] = values[i] }
    return [
        power: p.power == "on", level: p.speed_level as Integer,
        oscillation: p.angle_enable == "on", angle: p.angle as Integer,
        mode: p.mode == "natural" ? "natural" : "normal",
        buzzer: (p.buzzer as Integer) != 0, light: (p.led_b as Integer) != 2, lock: p.child_lock == "on"
    ]
}

private Map decodeMiot(List values) {
    Map p = [:]
    values.each { Map v -> if (v.code == 0) { p[v.did] = v.value } }
    if (p.size() != MIOT_PROPS.size()) {
        return null
    }
    return [
        power: p.power as Boolean, level: p.level as Integer,
        oscillation: p.oscillation as Boolean, angle: p.angle as Integer,
        mode: p.mode == 1 ? "natural" : "normal",
        buzzer: p.buzzer as Boolean, light: p.light as Boolean, lock: p.lock as Boolean
    ]
}

private void applyState(Map s) {
    if (s == null) {
        log.warn "unexpected poll reply"
        return
    }
    Boolean night = isNight()
    sendEvent(name: "connection", value: "online")
    sendEvent(name: "nightMode", value: night ? "on" : "off")
    publish(s)
    enforce(s, night)
}

// Reports the keys present in s. Commands call it before the fan confirms, so a control does not
// fall back to the old value while the write is in flight; the read after the write corrects it.
private void publish(Map s) {
    if (s.containsKey("power")) {
        sendEvent(name: "switch", value: s.power ? "on" : "off")
    }
    if (s.containsKey("level")) {
        sendEvent(name: "level", value: s.level, unit: "%")
    }
    if (s.containsKey("power") || s.containsKey("level")) {
        Boolean isOn = s.containsKey("power") ? s.power : device.currentValue("switch") == "on"
        Integer level = (s.containsKey("level") ? s.level : device.currentValue("level")) as Integer
        sendEvent(name: "speed", value: isOn ? speedName(level ?: 0) : "off")
    }
    if (s.containsKey("oscillation")) {
        sendEvent(name: "oscillation", value: s.oscillation ? "on" : "off")
        childSwitch("oscillation", s.oscillation as Boolean)
    }
    if (s.containsKey("angle")) {
        sendEvent(name: "oscillationAngle", value: s.angle)
    }
    if (s.containsKey("mode")) {
        sendEvent(name: "windMode", value: s.mode)
    }
}

private String speedName(Integer level) {
    if (level <= 25) { return "low" }
    if (level <= 50) { return "medium-low" }
    if (level <= 75) { return "medium" }
    return "high"
}

// Tells two fans apart by the last four digits of the MAC address. A device or child whose name
// was changed keeps it.
private void applyDefaultName(String mac) {
    String digits = (mac ?: "").replaceAll("[^0-9A-Fa-f]", "").toUpperCase()
    if (digits.length() < 4 || device.name != DRIVER_NAME) {
        return
    }
    String name = "${DRIVER_NAME} ${digits.substring(digits.length() - 4)}"
    CHILDREN.each { String key, String suffix ->
        def child = getChildDevice(childDni(key))
        if (child?.name == "${DRIVER_NAME} ${suffix}".toString()) {
            child.setName("${name} ${suffix}")
        }
    }
    device.setName(name)
}

// ---- child switches ----

private String childDni(String key) {
    return "${device.deviceNetworkId}-${key}".toString()
}

private String childKey(cd) {
    return cd.deviceNetworkId.toString() - "${device.deviceNetworkId}-".toString()
}

private void ensureChildren() {
    CHILDREN.each { String key, String suffix ->
        Boolean wanted = key == "oscillation" || settings.moveSwitches
        def child = getChildDevice(childDni(key))
        if (wanted && !child) {
            addChildDevice("hubitat", "Generic Component Switch", childDni(key),
                [name: "${device.displayName} ${suffix}", isComponent: true])
        } else if (!wanted && child) {
            deleteChildDevice(childDni(key))
        }
        if (wanted && key != "oscillation") {
            childSwitch(key, false)
        }
    }
}

// force repeats the event although the value is unchanged, for a request that was refused.
private void childSwitch(String key, Boolean on, Boolean force = false) {
    def child = getChildDevice(childDni(key))
    if (!child) {
        return
    }
    String value = on ? "on" : "off"
    Map event = [name: "switch", value: value, descriptionText: "${child.displayName} was turned ${value}"]
    if (force) {
        event.isStateChange = true
    }
    child.parse([event])
}
