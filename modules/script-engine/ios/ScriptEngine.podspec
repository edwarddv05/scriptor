Pod::Spec.new do |s|
  s.name           = 'ScriptEngine'
  s.version        = '0.1.0'
  s.summary        = 'JavaScriptCore runtime with native iOS APIs for Scriptor'
  s.description    = 'Runs user scripts in an isolated JSContext and exposes files, network, photos, video, audio and crypto APIs.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Video.play: VLC decodes AV1 (dav1d), MKV and WebM in software on any iPhone.
  s.dependency 'MobileVLCKit', '~> 3.7'
  s.frameworks = 'JavaScriptCore', 'Photos', 'PhotosUI', 'AVFoundation', 'CryptoKit', 'UniformTypeIdentifiers', 'ImageIO', 'QuickLook', 'UserNotifications',
                     'WebKit', 'EventKit', 'EventKitUI', 'Contacts', 'CoreLocation', 'MessageUI', 'SafariServices', 'Speech'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
