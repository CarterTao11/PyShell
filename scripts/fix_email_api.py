# -*- coding: utf-8 -*-
fp = r'D:\work\pyshell\backend\api.py'
with open(fp, 'r', encoding='utf-8') as f:
    c = f.read()

# Add test email endpoint after update_settings
old = '''@api_bp.route("/api/settings", methods=["PUT"])
def update_settings():
    data = request.get_json(force=True)
    for key, value in data.items():
        setting = Setting.query.get(key)
        if setting:
            setting.value = str(value)
        else:
            setting = Setting(key=key, value=str(value))
            db.session.add(setting)
    db.session.commit()
    return jsonify({"success": True})'''

new = '''@api_bp.route("/api/settings", methods=["PUT"])
def update_settings():
    data = request.get_json(force=True)
    for key, value in data.items():
        setting = Setting.query.get(key)
        if setting:
            setting.value = str(value)
        else:
            setting = Setting(key=key, value=str(value))
            db.session.add(setting)
    db.session.commit()
    return jsonify({"success": True})


@api_bp.route("/api/settings/email/test", methods=["POST"])
def test_email():
    """发送测试邮件验证配置"""
    from email_notifier import send_email
    result = send_email(
        subject="[PyShell] 邮件配置测试",
        body="这是一封测试邮件，如果您收到此邮件，说明邮件配置正确。\n\nPyShell SSH 客户端",
    )
    return jsonify(result)'''

c = c.replace(old, new)
with open(fp, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK')