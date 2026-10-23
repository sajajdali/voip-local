const req = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error('missing env ' + k);
  return v;
};

export const env = {
  port: +req('PORT', '3000'),
  jwtSecret: req('JWT_SECRET', 'dev-secret'),
  amiHost: req('AMI_HOST', '127.0.0.1'),
  amiPort: +req('AMI_PORT', '5038'),
  amiUser: req('AMI_USER', 'ccapi'),
  amiSecret: req('AMI_SECRET', ''),
  hookSecret: req('HOOK_SECRET', 'dev-hook'),
  hookUrl: req('HOOK_URL', 'http://127.0.0.1:3000/api/hooks'),
  confDir: req('ASTERISK_CC_CONF_DIR', '/etc/asterisk/cc'),
  soundsDir: req('ASTERISK_SOUNDS_DIR', '/var/lib/asterisk/sounds/custom'),
  mohDir: req('ASTERISK_MOH_DIR', '/var/lib/asterisk/moh-cc'),
  monitorDir: req('ASTERISK_MONITOR_DIR', '/var/spool/asterisk/monitor'),
  shortCallSec: +req('SHORT_CALL_SEC', '5'),
  queueLog: req('ASTERISK_QUEUE_LOG', '/var/log/asterisk/queue_log'),
  demoAudio: req('DEMO_AUDIO', '/var/lib/callcenter/demo.wav'),
  clinicApiUrl: process.env.CLINIC_API_URL || '',
  clinicApiToken: process.env.CLINIC_API_TOKEN || '',
  clinicLookupPath: process.env.CLINIC_LOOKUP_PATH || '/patients?mobile={phone}',
  aiProvider: process.env.AI_PROVIDER || 'keywords',
  sttUrl: process.env.STT_URL || '',
};
