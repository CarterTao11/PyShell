# -*- coding: utf-8 -*-
import re

# 1. Add backend touch endpoint
fp1 = r'D:\work\pyshell\backend\api.py'
with open(fp1, 'r', encoding='utf-8') as f:
    c = f.read()

touch_api = '''
@api_bp.route("/api/sftp/touch/<conn_id>", methods=["POST"])
def sftp_touch(conn_id):
    """Create an empty file on remote via SFTP."""
    data = request.get_json(force=True)
    path = data.get("path", "")
    if not path:
        return jsonify({"success": False, "error": "No path provided"}), 400
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        with sftp.open(path, 'w') as f:
            f.write('')
        return jsonify({"success": True, "path": path})
    except Exception as e:
        logger.exception(f"SFTP touch failed [{conn_id}]: {path}")
        return jsonify({"success": False, "error": str(e)}), 500


'''

# Insert touch endpoint after mkdir endpoint
old = '''def sftp_mkdir(conn_id):'''
new = '''def sftp_touch(conn_id):
    """Create an empty file on remote via SFTP."""
    data = request.get_json(force=True)
    path = data.get("path", "")
    if not path:
        return jsonify({"success": False, "error": "No path provided"}), 400
    try:
        client = conn_mgr.get_connection(conn_id)
        sftp = client.get_sftp_client()
        with sftp.open(path, 'w') as f:
            f.write('')
        return jsonify({"success": True, "path": path})
    except Exception as e:
        logger.exception(f"SFTP touch failed [{conn_id}]: {path}")
        return jsonify({"success": False, "error": str(e)}), 500


def sftp_mkdir(conn_id):'''

c = c.replace(old, new)
with open(fp1, 'w', encoding='utf-8') as f:
    f.write(c)
print('Backend touch endpoint added')

# 2. Update frontend context menu
fp2 = r'D:\work\pyshell\web\js\sftp.js'
with open(fp2, 'r', encoding='utf-8') as f:
    c = f.read()

# Add "新建文件" to directory context menu
old = '''        if (isDir) {
            menu.innerHTML = `
                <div class="context-menu-item" data-action="open">打开</div>
            `;
        }'''
new = '''        if (isDir) {
            menu.innerHTML = `
                <div class="context-menu-item" data-action="newfile">新建文件</div>
                <div class="context-menu-item" data-action="newfolder">新建文件夹</div>
                <div class="context-menu-divider"></div>
                <div class="context-menu-item" data-action="open">打开</div>
            `;
        }'''

c = c.replace(old, new)

# Add newfile and newfolder actions
old2 = '''                if (action === 'edit') this.editFile(filePath);
                else if (action === 'download') this.download(filePath);
                else if (action === 'delete') this.deleteFile(filePath, isDir);
                else if (action === 'open') {'''
new2 = '''                if (action === 'newfile') this.newFile(filePath);
                else if (action === 'newfolder') this.newFolder(filePath);
                else if (action === 'edit') this.editFile(filePath);
                else if (action === 'download') this.download(filePath);
                else if (action === 'delete') this.deleteFile(filePath, isDir);
                else if (action === 'open') {'''

c = c.replace(old2, new2)

with open(fp2, 'w', encoding='utf-8') as f:
    f.write(c)
print('Frontend context menu updated')

# 3. Add newFile and newFolder methods to the SFTP panel
old3 = '''    async mkdir(connId) {'''
new3 = '''    async newFile(parentPath) {
        const fileName = prompt('文件名:', 'newfile.txt');
        if (!fileName) return;
        const fullPath = (parentPath.endsWith('/') ? parentPath : parentPath + '/') + fileName;
        try {
            await fetch('/api/sftp/touch/' + this.currentConnId, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({path: fullPath}),
            });
            // Check if browse dir is the parent
            if (this.currentPath && fullPath.startsWith(this.currentPath)) {
                this.browse(this.currentConnId, this.currentPath);
            }
        } catch (e) {
            alert('创建文件失败: ' + e.message);
        }
    },

    async newFolder(parentPath) {
        const folderName = prompt('文件夹名:', 'newfolder');
        if (!folderName) return;
        const fullPath = (parentPath.endsWith('/') ? parentPath : parentPath + '/') + folderName;
        try {
            await fetch('/api/sftp/mkdir/' + this.currentConnId, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({path: fullPath}),
            });
            if (this.currentPath && fullPath.startsWith(this.currentPath)) {
                this.browse(this.currentConnId, this.currentPath);
            }
        } catch (e) {
            alert('创建文件夹失败: ' + e.message);
        }
    },

    async mkdir(connId) {'''

c = c.replace(old3, new3)

with open(fp2, 'w', encoding='utf-8') as f:
    f.write(c)
print('newFile/newFolder methods added')

# 4. Add CSS for context menu divider
fp3 = r'D:\work\pyshell\web\css\style.css'
with open(fp3, 'r', encoding='utf-8') as f:
    c = f.read()

old4 = '/* SFTP panel */'
new4 = '''/* Context menu */
.context-menu-divider {
    height: 1px;
    background: #333;
    margin: 4px 8px;
}

/* SFTP panel */'''

c = c.replace(old4, new4)
with open(fp3, 'w', encoding='utf-8') as f:
    f.write(c)
print('CSS divider added')