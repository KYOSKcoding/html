from bs4 import BeautifulSoup
import json
import requests

# URL of the page to scrape
url = "https://tacker.fr/kyosk"  # Change this to the actual site

# Fetch the page content
response = requests.get(url)
soup = BeautifulSoup(response.text, "html.parser")

# Find the main event container
event_container = soup.find(id="block-views-block-events-block-2-2")

# Extract individual event entries
events = event_container.find_all("div", class_="views-row row-has-day-month")

# Iterate through events and extract details
event_list = []
for event in events:
    title = event.find("h4").text.strip()
    link = event.find("a")["href"]
    description = event.find("div", class_="details").text.strip()

    # Extract date and time
    date_month = event.find("div", class_="date-month").text.strip()
    date_day = event.find("div", class_="date-day").text.strip()
    time_elements = event.find_all("time")
    start_time = time_elements[0].text if len(time_elements) > 0 else "Unknown"
    end_time = time_elements[1].text if len(time_elements) > 1 else "Unknown"

    # Extract event type and location
    event_type = (
        event.find("div", class_="event-type").text.strip()
        if event.find("div", class_="event-type")
        else "Unknown"
    )
    location = (
        event.find("div", class_="location-reference").text.strip()
        if event.find("div", class_="location-reference")
        else "Unknown"
    )

    event_data = {
        "title": title,
        "description": description,
        "date": f"{date_day}. {date_month}",
        "start_time": start_time,
        "end_time": end_time,
        "event_type": event_type,
        "datetime": time_elements[0]["datetime"] if time_elements else "",
    }

    event_list.append(event_data)

# HTML header for the page
html_content = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" media="screen" href="https://fontlibrary.org/en/face/terminal-grotesque" type="text/css" />
    <title>Event List</title>
    <style>
        @font-face {
            font-family: 'TerminalGrotesqueOpenRegular';
            src: url('TerminalGrotesqueOpenRegular.woff2') format('woff2'),
                 url('TerminalGrotesqueOpenRegular.woff') format('woff');
            font-weight: normal;
            font-style: normal;
        }

        body {
            font-family: 'TerminalGrotesqueOpenRegular', monospace;
            padding: 20px;
            line-height: 1.5;
        }

        .event-list {
            list-style-type: none;
            padding: 0;
        }

        .event {
            margin-bottom: 20px;
            padding: 15px;
            border-left: 5px solid #25f6fd;
            background-color: #ffbaee;
        }

        .event-date {
            font-weight: bold;
            font-size: 1.2rem;
            color: #1a3e72;
        }

        .event-title {
            font-weight: bold;
            font-size: 1.1rem;
            margin: 5px 0;
        }

        .event-time {
            color: #444;
            font-size: 0.95rem;
        }

        .event-description {
            margin-top: 5px;
            font-size: 0.95rem;
            color: #333;
        }

        .event-type {
            font-style: italic;
            font-size: 0.9rem;
            color: #666;
        }
    </style>
</head>
<body>

<h2>
<a href="https://tacker.fr/kyosk" title="tacker.fr" target="_blank"> tacker.fr News</a>
</h2>
<ul class="event-list">
"""

# Loop over the events and generate a bucket list item for each one
for event in event_list:
    html_content += f"""
    <li class="event">
        <div class="event-date">{event['date']}</div>
        <div class="event-title">{event['title']}</div>
        <div class="event-time">{event['start_time'].split(":")[0]}h - {event['end_time'].split(":")[0]}h</div>
        <div class="event-description">{event['description']}</div>
        <div class="event-type">{event['event_type']}</div>
    </li>
    """

# HTML footer to close the list and the page
html_content += """
</ul>

</body>
</html>
"""

# Save the HTML content to a file
with open("/home/kyosk/html/events_table.html", "w") as file:
    file.write(html_content)

print("events_table.html created successfully.")

# Next jam session for the flyer on the start page
jam = {}
for event in event_list:
    if "jam" in event["title"].lower() and event["datetime"]:
        year, month, day = event["datetime"][:10].split("-")
        jam = {
            "date": f"{day}.{month}.",
            "start": event["start_time"].split(":")[0],
            "end": event["end_time"].split(":")[0],
            "title": event["title"],
        }
        break

with open("/home/kyosk/html/jam.json", "w") as file:
    json.dump(jam, file, ensure_ascii=False)

# # Print results
# for e in event_list:
#     print(e)
