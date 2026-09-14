/**
 * `server-only` paketinin test karşılığı: boş.
 *
 * Gerçek paket, bir modül istemci paketine sızarsa DERLEMEDE patlıyor.
 * Bu koruma Next'in bundler'ında çalışıyor ve `next build` sırasında hâlâ
 * yürürlükte — burada devre dışı bırakmak onu zayıflatmıyor, yalnızca
 * Node'da modülün çözülmesini sağlıyor.
 */
export {}
