part of '../settings_page.dart';

/// Self-hosted buzz-push-gateway the client enrolls against (crichton,
/// tailscale serve, buzz port block 6359). Dev-signed builds enroll into the
/// sandbox APNs profile; the gateway's enabled profiles must include it.
const String kPushGatewayBaseUrl = 'https://crichton.tailb3d4b8.ts.net:6359';

String _pushLeasePrefKey(String relayOrigin) =>
    'buzz.push-lease.v1:${Uri.encodeComponent(relayOrigin.trim().toLowerCase())}';

class _PushSection extends ConsumerStatefulWidget {
  const _PushSection();

  @override
  ConsumerState<_PushSection> createState() => _PushSectionState();
}

class _PushSectionState extends ConsumerState<_PushSection> {
  bool _busy = false;
  String? _error;
  int? _activeGeneration;

  @override
  void initState() {
    super.initState();
    _restoreState();
  }

  Future<void> _restoreState() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    final raw = prefs.getString(_pushLeasePrefKey(ref.read(relayConfigProvider).baseUrl));
    if (raw == null) return;
    final state = jsonDecode(raw) as Map<String, dynamic>;
    final active = state['active'] as bool? ?? false;
    if (active) {
      setState(() => _activeGeneration = state['generation'] as int?);
    }
  }

  Future<void> _persist(bool active, int generation) async {
    final prefs = await SharedPreferences.getInstance();
    final key = _pushLeasePrefKey(ref.read(relayConfigProvider).baseUrl);
    final raw = prefs.getString(key);
    final state = (raw == null ? <String, dynamic>{} : jsonDecode(raw) as Map<String, dynamic>)
      ..['active'] = active
      ..['generation'] = generation;
    await prefs.setString(key, jsonEncode(state));
  }

  PushEnrollmentService _buildService() {
    final config = ref.read(relayConfigProvider);
    final session = ref.read(relaySessionProvider.notifier);
    final prefsFuture = SharedPreferences.getInstance();
    return PushEnrollmentService(
      relayHttpOrigin: config.baseUrl,
      gatewayBaseUrl: kPushGatewayBaseUrl,
      attest: PushAttestChannel(),
      publish: ({required kind, required content, required tags}) async {
        final relay = SignedEventRelay(session: session, nsec: config.nsec);
        await relay.submit(kind: kind, content: content, tags: tags);
      },
      readLeaseState: () async {
        final prefs = await prefsFuture;
        final raw = prefs.getString(_pushLeasePrefKey(config.baseUrl));
        if (raw == null) return null;
        final state = jsonDecode(raw) as Map<String, dynamic>;
        return PushLeaseState(
          generation: state['generation'] as int? ?? 0,
          installationHandle: state['installation_handle'] as String?,
        );
      },
      writeLeaseState: (state) async {
        final prefs = await prefsFuture;
        await prefs.setString(
          _pushLeasePrefKey(config.baseUrl),
          jsonEncode({
            'generation': state.generation,
            'installation_handle': state.installationHandle,
          }),
        );
      },
    );
  }

  Future<void> _enable() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final config = ref.read(relayConfigProvider);
      final service = _buildService();
      final result = await service.enable(
        userPubkey: SignedEventRelay(session: ref.read(relaySessionProvider.notifier), nsec: config.nsec)
            .pubkey!,
      );
      await _persist(true, result.generation);
      if (mounted) {
        setState(() => _activeGeneration = result.generation);
      }
    } on PushEnrollmentException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on PushAttestException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disable() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _buildService().disable();
      await _persist(false, _activeGeneration ?? 0);
      if (mounted) setState(() => _activeGeneration = null);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(relayConfigProvider);
    final authState = ref.watch(authProvider).value;
    final signedIn = config.nsec != null && config.nsec!.isNotEmpty && authState?.community != null;

    return AppListCard(
      label: 'Notifications',
      verticalPadding: Grid.twelve,
      children: [
        if (signedIn)
          AppListRow(
            icon: LucideIcons.bellRing,
            title: 'Push notifications',
            subtitle: _subtitle(),
            trailing: Switch(
              value: _activeGeneration != null,
              onChanged: _busy
                  ? null
                  : (_) {
                      if (_activeGeneration != null) {
                        _disable();
                      } else {
                        _enable();
                      }
                    },
            ),
          )
        else
          AppListRow(
            icon: LucideIcons.bellRing,
            title: 'Push notifications',
            subtitle: 'Sign in to enable mention and alert banners',
            trailing: const Switch(value: false, onChanged: null),
          ),
      ],
    );
  }

  String _subtitle() {
    if (_busy) return 'Enrolling…';
    if (_error != null) return _error!;
    if (_activeGeneration != null) {
      return 'Mention banners active (generation $_activeGeneration)';
    }
    return 'Mention and alert banners on this device';
  }
}
