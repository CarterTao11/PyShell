import sqlite3
import os

db_path = os.path.join(os.path.dirname(__file__), 'data', 'pyshell.db')
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# 检查列是否存在
cursor.execute("PRAGMA table_info(command_favorites)")
columns = [row[1] for row in cursor.fetchall()]
print('当前列:', columns)

if 'sort_order' not in columns:
    cursor.execute('ALTER TABLE command_favorites ADD COLUMN sort_order INTEGER DEFAULT 0')
    conn.commit()
    print('已添加 sort_order 列')
else:
    print('sort_order 列已存在')

conn.close()
print('完成!')
