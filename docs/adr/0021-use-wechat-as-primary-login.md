# 使用微信作为主要登录入口

正式邀请制 Beta 使用微信开放平台网站应用 OAuth 作为主要登录入口，邮箱用于每日摘要、账号恢复和安全通知。系统以内部 `user_id` 标识求职账户，微信 openid/unionid 只作为外部身份；本地开发在正式域名和网站应用审核完成前使用明确标识的 Dev Auth Adapter。AppSecret 仅保存在 API 服务端，OAuth 回调校验 state，微信身份逻辑不进入求职画像等领域模块。
