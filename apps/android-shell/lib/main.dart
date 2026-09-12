// Hey Hawk — Android wrapper for the Voice A/B page.
// Full-screen WebView with mic granted, self-signed HTTPS trusted via the bundled CA,
// and a NATIVE wake word (Android speech recognizer) that pokes the page, because a
// WebView has no Web Speech API.
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

// Where the page lives. Build with:
//   flutter build apk --release --dart-define=HAWK_URL=https://<your-laptop-lan-ip>:3443/voice \
//                               --dart-define=HAWK_URL_ALT=https://<your-tailnet-ip>:3443/voice
const urls = <String>[
  String.fromEnvironment('HAWK_URL', defaultValue: 'https://192.168.1.10:3443/voice'),
  String.fromEnvironment('HAWK_URL_ALT', defaultValue: 'https://192.168.1.10:3443/voice'),
];
const wakePhrase = 'hey hawk';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge); // nav bar stays reachable: never trap the user
  runApp(const MaterialApp(debugShowCheckedModeBanner: false, home: HawkScreen()));
}

class HawkScreen extends StatefulWidget {
  const HawkScreen({super.key});
  @override
  State<HawkScreen> createState() => _HawkScreenState();
}

class _HawkScreenState extends State<HawkScreen> with WidgetsBindingObserver {
  late final WebViewController _web;
  final _stt = stt.SpeechToText();
  bool _sttReady = false;
  bool _listening = false;
  bool _paused = false; // page owns the mic right now
  int _urlIdx = 0;
  String _status = 'loading';
  DateTime _lastWake = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final delegate = NavigationDelegate(
      onPageFinished: (_) => setState(() => _status = 'ready'),
      onWebResourceError: (e) {
        if (e.isForMainFrame == true && _urlIdx + 1 < urls.length) {
          _urlIdx++; _web.loadRequest(Uri.parse(urls[_urlIdx]));
        }
      },
    );
    final nav = delegate.platform;
    if (nav is AndroidNavigationDelegate) {
      nav.setOnSSlAuthError((e) => e.proceed()); // our own self-signed demo cert
    }
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0E0F13))
      ..addJavaScriptChannel('HawkNative', onMessageReceived: (m) {
        // Android gives the mic to one client: yield to the page while it records/speaks.
        if (m.message == 'mic:busy') { _paused = true; _stopListen(); }
        else if (m.message == 'mic:free') { _paused = false; _restartListen(); }
      })
      ..setNavigationDelegate(delegate);
    final platform = _web.platform;
    if (platform is AndroidWebViewController) {
      platform.setMediaPlaybackRequiresUserGesture(false);
      platform.setUseWideViewPort(true); // honour the page's viewport meta
      platform.setOverScrollMode(WebViewOverScrollMode.ifContentScrolls);
      platform.setOnPlatformPermissionRequest((req) => req.grant()); // mic for the page
    }
    _boot();
  }

  Future<void> _boot() async {
    await Permission.microphone.request();
    await _web.loadRequest(Uri.parse(urls[_urlIdx]));
    _sttReady = await _stt.initialize(onStatus: _onSttStatus, onError: (_) => _restartListen());
    if (_sttReady) _startListen();
  }

  void _onSttStatus(String s) { if (s == 'done' || s == 'notListening') _restartListen(); }
  void _stopListen() { _listening = false; try { _stt.stop(); } catch (_) {} }
  void _restartListen() { if (!_sttReady || _paused) return; Future.delayed(const Duration(milliseconds: 400), _startListen); }

  Future<void> _startListen() async {
    if (!_sttReady || _listening || _paused) return;
    _listening = true;
    try {
      await _stt.listen(
        onResult: (r) {
          final t = r.recognizedWords.toLowerCase();
          if (t.contains(wakePhrase) && DateTime.now().difference(_lastWake).inSeconds > 4) {
            _lastWake = DateTime.now();
            HapticFeedback.mediumImpact();
            _paused = true; _stopListen(); // hand the mic to the page for this turn
            Future.delayed(const Duration(seconds: 30), () { if (_paused) { _paused = false; _restartListen(); } });
            _web.runJavaScript("window.dispatchEvent(new CustomEvent('hawk-wake',{detail:{source:'android'}}))");
          }
        },
        listenFor: const Duration(seconds: 25),
        pauseFor: const Duration(seconds: 6),
        listenOptions: stt.SpeechListenOptions(partialResults: true, listenMode: stt.ListenMode.dictation, cancelOnError: true),
      );
    } catch (_) {}
    _listening = false;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    // Never hold the mic from the background: Chrome/other apps would record silence.
    if (s == AppLifecycleState.resumed) { _restartListen(); } else { _stopListen(); }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        // Android back: step back inside the page, else leave the app.
        if (await _web.canGoBack()) { await _web.goBack(); return; }
        SystemNavigator.pop();
      },
      child: Scaffold(
      backgroundColor: const Color(0xFF0E0F13),
      body: SafeArea(
        child: Stack(children: [
          WebViewWidget(
            controller: _web,
            // Claim every touch for the WebView so the page scrolls (both axes)
            // instead of Flutter's gesture arena swallowing the drag.
            gestureRecognizers: <Factory<OneSequenceGestureRecognizer>>{
              Factory<OneSequenceGestureRecognizer>(() => EagerGestureRecognizer()),
            },
          ),
          if (_status != 'ready')
            const Center(child: CircularProgressIndicator(color: Color(0xFF5EE1A4))),
        ]),
      ),
    ));
  }
}
