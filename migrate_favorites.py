#!/usr/bin/env python
"""添加 sort_order 列到 command_favorites 表"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from backend.app import app
from backend.models import db

with app.app_context():
    # 检查列是否存在
    result = db.session.execute(db.text("PRAGMA table_info(command_favorites)"))
    columns = [row[1] for row in result]
    print('当前列:', columns)
    
    if 'sort_order' not in columns:
        # 添加列
        db.session.execute(db.text('ALTER TABLE command_favorites ADD COLUMN sort_order INTEGER DEFAULT 0'))
        db.session.commit()
        print('已添加 sort_order 列')
    else:
        print('sort_order 列已存在')
    
    print('完成!')
