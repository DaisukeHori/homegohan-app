# セキュリティポリシー (Security Policy)

ほめゴハン (homegohan) の脆弱性 (セキュリティ上の問題) を見つけたときは、この方法で知らせてください。
見つけてくださって、ありがとうございます。

## 報告のしかた

専用のメールアドレスは、まだありません。用意できたら、このファイルに書きます。
それまでは、サイトのお問い合わせフォームから報告してください。

1. お問い合わせフォームを開く: <https://homegohan-app.vercel.app/contact>
2. 「お問い合わせ種別」は「バグ・不具合の報告」を選ぶ。
3. 「件名」の先頭に **【セキュリティ】** と書く。
4. 「メールアドレス」に、連絡を受け取れるアドレスを書く。
5. 「お問い合わせ内容」に、次のことを書く。
   - 何が起きるか (どんな被害になりうるか)
   - 再現の手順 (短くてかまいません)
   - 見つけた場所 (画面や API の URL、アプリの画面名など)
   - 使った環境 (ブラウザやアプリの版など。分かる範囲で)

## お願い

- 脆弱性の詳細を、GitHub の Issue・Pull Request・Discussion など、誰でも読める場所に書かないでください。
- 確かめるのに必要な、最小限の操作にとどめてください。
  他の人のデータを見る・変える・消すことや、サービスが止まるほどの負荷をかけることは、しないでください。
- 他の人の個人情報やパスワードが見えてしまったときは、コピーを残さず、見えた場所だけを知らせてください。
- 修正が終わるまで、第三者には公開しないでください。

## 受け付けたあと

- 内容を確認して、必要な対応を進めます。確認のために、書いていただいた連絡先に問い合わせることがあります。
- 直す時期は約束できませんが、被害が大きいものから順に対応します。

## 対象

- 本番のサイトとアプリ、およびこのリポジトリのコード。
- Supabase・Vercel・Stripe など、外部のサービスそのものの脆弱性は、それぞれのサービスの窓口に報告してください。

---

## English summary

Please report a security vulnerability through the contact form at <https://homegohan-app.vercel.app/contact>.
Choose the type "バグ・不具合の報告" (bug report), start the subject with "【セキュリティ】" ("Security"),
and leave an email address we can reach you at.
A dedicated security mailbox does not exist yet. This file will be updated when it does.

Please do not describe a vulnerability in a public GitHub issue, pull request, or discussion,
and please do not access, change, or delete other people's data, or degrade the service, while testing.
