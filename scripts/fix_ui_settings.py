# -*- coding: utf-8 -*-
fp = r'D:\work\pyshell\web\index.html'
with open(fp, 'r', encoding='utf-8') as f:
    c = f.read()

# Add settings tab content after SFTP tab content
old = '''            </div>
        </aside>

        <!-- 侧边栏拖拽调宽手柄 -->'''
new = '''            </div>
            <div id="tab-content-settings" class="tab-content">
                <div class="settings-scroll">
                    <h3 style="margin:0 0 12px 0;font-size:14px;color:var(--text)">📧 邮件通知配置</h3>
                    <div class="form-group">
                        <label>SMTP 服务器</label>
                        <input type="text" id="smtp-server" placeholder="smtp.qq.com">
                    </div>
                    <div class="form-group">
                        <label>端口</label>
                        <input type="number" id="smtp-port" value="465">
                    </div>
                    <div class="form-group">
                        <label>邮箱账号</label>
                        <input type="text" id="smtp-user" placeholder="your@qq.com">
                    </div>
                    <div class="form-group">
                        <label>SMTP 授权码/密码</label>
                        <input type="password" id="smtp-pass" placeholder="SMTP 授权码">
                    </div>
                    <div class="form-group">
                        <label>发件人显示名称</label>
                        <input type="text" id="smtp-sender" placeholder="PyShell <your@qq.com>">
                    </div>
                    <div class="form-group">
                        <label>接收邮箱（多个用 ; 分隔）</label>
                        <input type="text" id="smtp-recipients" placeholder="admin@example.com;user@example.com">
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:8px">
                        <label style="margin:0;cursor:pointer">
                            <input type="checkbox" id="smtp-enabled" checked>
                            启用邮件通知
                        </label>
                    </div>
                    <div class="form-group" style="display:flex;gap:8px">
                        <button id="btn-save-email-settings" class="btn btn-sm btn-primary" style="flex:1">保存配置</button>
                        <button id="btn-test-email" class="btn btn-sm" style="flex:1">发送测试邮件</button>
                    </div>
                    <div id="email-status" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>
                </div>
            </div>
        </aside>

        <!-- 侧边栏拖拽调宽手柄 -->'''

c = c.replace(old, new)
with open(fp, 'w', encoding='utf-8') as f:
    f.write(c)
print('Settings tab added')