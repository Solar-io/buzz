import 'package:flutter/services.dart';

/// Opens the native iOS form used to edit a single profile text field.
class IosProfileTextEditor {
  IosProfileTextEditor._();

  static const _channel = MethodChannel('buzz/profile_text_editor');

  static Future<String?> present({
    required String title,
    required String initialValue,
    required String placeholder,
    required bool multiline,
  }) => _channel.invokeMethod<String>('present', {
    'title': title,
    'initialValue': initialValue,
    'placeholder': placeholder,
    'multiline': multiline,
  });
}
