import AVFoundation
import AppKit
import CoreText
import Foundation

let width = 1280
let height = 720
let fps: Int32 = 30
let duration = 60.0
let frameCount = Int(duration * Double(fps))

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first
  ?? "hackathon/reversal-agent/demo.mp4")

struct Row {
  var text: String
  var color: (CGFloat, CGFloat, CGFloat)
  var at: Double
}

struct Scene {
  var start: Double
  var end: Double
  var kicker: String
  var rows: [Row]
}

let dim = (CGFloat(0.62), CGFloat(0.66), CGFloat(0.70))
let paper = (CGFloat(0.93), CGFloat(0.95), CGFloat(0.96))
let green = (CGFloat(0.45), CGFloat(0.86), CGFloat(0.62))
let amber = (CGFloat(0.96), CGFloat(0.74), CGFloat(0.35))
let blue = (CGFloat(0.55), CGFloat(0.75), CGFloat(0.98))

let scenes: [Scene] = [
  Scene(start: 0, end: 7, kicker: "reversal-agent  ·  Atlas Cluster0", rows: [
    Row(text: "Reversal agent", color: paper, at: 0.4),
    Row(text: "Audited trip-fee disputes with governed memory", color: blue, at: 1.2),
    Row(text: "", color: dim, at: 1.6),
    Row(text: "$ npm run demo", color: green, at: 2.2),
    Row(text: "perception → graph → memory → ledger → policy → post", color: dim, at: 3.2),
  ]),
  Scene(start: 7, end: 20, kicker: "1  ·  route complaint  ·  dispute:dsp-route", rows: [
    Row(text: "Driver took a longer route. Expected 10 km, drove 10.8.", color: paper, at: 0.3),
    Row(text: "graph lookup     4 nodes, trip reached", color: dim, at: 1.6),
    Row(text: "memory           mem-route-15  (closest)", color: blue, at: 2.8),
    Row(text: "ledger           one ride payment, 42.00 CAD", color: dim, at: 4.0),
    Row(text: "decision         DISMISS", color: green, at: 5.3),
    Row(text: "8.0% over, no photo. That memory changed the outcome.", color: paper, at: 6.6),
    Row(text: "without it       refund 3.36 CAD", color: amber, at: 8.0),
    Row(text: "earnings         may leave the reserve", color: green, at: 9.4),
  ]),
  Scene(start: 20, end: 34, kicker: "2  ·  duplicate charge  ·  dispute:dsp-over", rows: [
    Row(text: "I was charged twice for the same completed trip.", color: paper, at: 0.3),
    Row(text: "ledger           two ride payments, 86.00 CAD extra", color: dim, at: 1.6),
    Row(text: "policy           86.00 is above the 25 CAD cap", color: amber, at: 3.0),
    Row(text: "status           AWAITING_AUTHORITY", color: amber, at: 4.4),
    Row(text: "resume           ops:amina  ·  dispute.resolve.elevated", color: blue, at: 6.0),
    Row(text: "commit           one clawback posted", color: green, at: 7.6),
    Row(text: "idempotency      clawback:dispute:dispute:dsp-over", color: dim, at: 9.0),
    Row(text: "resolved by      ops:amina", color: green, at: 10.4),
  ]),
  Scene(start: 34, end: 48, kicker: "3  ·  cancellation fee  ·  crash, then resume", rows: [
    Row(text: "Driver never arrived. Cancellation fee was captured.", color: paper, at: 0.3),
    Row(text: "trip             CANCELLED, fee still on the ledger", color: dim, at: 1.5),
    Row(text: "commit           reversal posted", color: green, at: 2.9),
    Row(text: "crash            step left sent, not verified", color: amber, at: 4.3),
    Row(text: "resume           retries that one step", color: blue, at: 5.8),
    Row(text: "result           idempotent, already posted", color: green, at: 7.2),
    Row(text: "rider +8.00    driver −6.40    platform −1.60", color: paper, at: 8.8),
    Row(text: "rollback         compensating entry, original row kept", color: dim, at: 10.4),
  ]),
  Scene(start: 48, end: 56, kicker: "4  ·  forget a memory the agent must not use again", rows: [
    Row(text: "before           mem-stale-fee, mem-cancel-noshow, mem-route-15", color: paper, at: 0.4),
    Row(text: "forget           mem-stale-fee   by ops:amina", color: amber, at: 2.2),
    Row(text: "after            mem-cancel-noshow, mem-route-15", color: green, at: 4.0),
    Row(text: "vector index lagged; the collection is what counts", color: dim, at: 5.6),
  ]),
  Scene(start: 56, end: 60, kicker: "audit  ·  every action has an actor", rows: [
    Row(text: "8 audit rows", color: paper, at: 0.3),
    Row(text: "agent:dispute-resolver    commit, suspend, idempotent retry", color: dim, at: 1.2),
    Row(text: "ops:amina                 elevated commit, rollback, forget", color: green, at: 2.2),
    Row(text: "Demo passed.", color: green, at: 3.2),
  ]),
]

func color(_ rgb: (CGFloat, CGFloat, CGFloat), _ alpha: CGFloat = 1) -> CGColor {
  CGColor(red: rgb.0, green: rgb.1, blue: rgb.2, alpha: alpha)
}

func drawLine(_ ctx: CGContext, _ text: String, x: CGFloat, baseline: CGFloat, size: CGFloat, rgb: (CGFloat, CGFloat, CGFloat)) {
  let font = CTFontCreateWithName("Menlo" as CFString, size, nil)
  let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1),
  ]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
  ctx.textPosition = CGPoint(x: x, y: baseline)
  CTLineDraw(line, ctx)
}

func render(_ ctx: CGContext, time: Double) {
  let bg = color((0.07, 0.08, 0.10))
  ctx.setFillColor(bg)
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

  ctx.setFillColor(color((0.11, 0.13, 0.16)))
  ctx.fill(CGRect(x: 0, y: height - 56, width: width, height: 56))
  ctx.setFillColor(color(green))
  ctx.fill(CGRect(x: 0, y: height - 56, width: 6, height: 56))

  let scene = scenes.first { time >= $0.start && time < $0.end } ?? scenes[scenes.count - 1]
  let local = time - scene.start
  drawLine(ctx, scene.kicker, x: 36, baseline: CGFloat(height - 36), size: 16, rgb: dim)

  var top: CGFloat = 110
  for row in scene.rows where local >= row.at {
    if row.text.isEmpty {
      top += 18
      continue
    }
    let age = local - row.at
    let shown = age < 0.18 ? String(row.text.prefix(Int(age / 0.012))) : row.text
    drawLine(ctx, shown, x: 64, baseline: CGFloat(height) - top - 28, size: 26, rgb: row.color)
    top += 58
  }

  let progress = time / duration
  ctx.setFillColor(color((0.18, 0.20, 0.24)))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: 8))
  ctx.setFillColor(color(blue))
  ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width) * progress, height: 8))
  let clock = String(format: "0:%02d  /  1:00", min(59, Int(time)))
  drawLine(ctx, clock, x: CGFloat(width - 210), baseline: 22, size: 14, rgb: dim)
}

try? FileManager.default.removeItem(at: output)
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: 2_500_000,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
  ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
  kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
guard writer.startWriting() else {
  fputs("writer failed: \(writer.error?.localizedDescription ?? "unknown")\n", stderr)
  exit(1)
}
writer.startSession(atSourceTime: .zero)

for index in 0..<frameCount {
  while !input.isReadyForMoreMediaData {
    Thread.sleep(forTimeInterval: 0.002)
  }
  var buffer: CVPixelBuffer?
  guard let pool = adaptor.pixelBufferPool else {
    fputs("no pixel buffer pool\n", stderr)
    exit(1)
  }
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
  guard let buffer else { exit(1) }
  CVPixelBufferLockBaseAddress(buffer, [])
  let ctx = CGContext(
    data: CVPixelBufferGetBaseAddress(buffer),
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  )!
  render(ctx, time: Double(index) / Double(fps))
  CVPixelBufferUnlockBaseAddress(buffer, [])
  let time = CMTime(value: CMTimeValue(index), timescale: fps)
  if !adaptor.append(buffer, withPresentationTime: time) {
    fputs("append failed: \(writer.error?.localizedDescription ?? "unknown")\n", stderr)
    exit(1)
  }
  if index % 300 == 0 { fputs("frame \(index)/\(frameCount)\n", stderr) }
}

input.markAsFinished()
let gate = DispatchSemaphore(value: 0)
writer.finishWriting { gate.signal() }
gate.wait()
if writer.status != .completed {
  fputs("finish failed: \(writer.error?.localizedDescription ?? writer.status.rawValue.description)\n", stderr)
  exit(1)
}
fputs("wrote \(output.path)\n", stderr)
