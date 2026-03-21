import json
import os

def format_issues(input_file, output_file):
    with open(input_file, 'r', encoding='utf-8') as f:
        issues = json.load(f)
    
    with open(output_file, 'w', encoding='utf-8') as f:
        for issue in issues:
            f.write(f"Issue Number: {issue.get('number', 'N/A')}\n")
            f.write(f"Title: {issue.get('title', 'N/A')}\n")
            
            # Format labels
            labels = issue.get('labels', [])
            if isinstance(labels, list) and len(labels) > 0:
                if isinstance(labels[0], dict):
                    label_names = [label.get('name', str(label)) for label in labels]
                else:
                    label_names = [str(label) for label in labels]
            else:
                label_names = []
            f.write(f"Labels: {', '.join(label_names)}\n")
            
            # Format comments
            f.write("Comments:\n")
            comments = issue.get('comments', [])
            if comments:
                for comment in comments:
                    if isinstance(comment, dict):
                        author = comment.get('user', {}).get('login', 'Unknown')
                        body = comment.get('body', '').strip()
                        f.write(f"  - [{author}]: {body}\n")
                    else:
                        f.write(f"  - {str(comment).strip()}\n")
            else:
                f.write("  None\n")
            
            # Format body
            f.write("\nBody:\n")
            body_content = issue.get('body', '')
            if body_content:
                f.write(f"{body_content}\n")
            else:
                f.write("None\n")
            
            f.write("-" * 80 + "\n\n")

if __name__ == '__main__':
    import sys
    if len(sys.argv) != 3:
        print("Usage: parse-issues.py <input.json> <output.txt>")
        sys.exit(1)
    format_issues(sys.argv[1], sys.argv[2])
