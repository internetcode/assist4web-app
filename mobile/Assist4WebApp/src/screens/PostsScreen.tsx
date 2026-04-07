import React, { useEffect, useState } from 'react';
import { StyleSheet, FlatList, Text, Alert, View } from 'react-native';
import { Card, Title, Paragraph, Button, ActivityIndicator } from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';
import { ASSIST4WEB_GRADIENT } from '../theme/branding';
import { API_BASE_URL, withApiHeaders } from '../config/network';

type Post = {
  id: number;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  sticky?: boolean;
  _embedded?: {
    'wp:featuredmedia'?: Array<{
      source_url?: string;
    }>;
  };
};

const PostsScreen = ({ navigation }: any) => {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPosts();
  }, []);

  const fetchPosts = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/posts`, {
        headers: withApiHeaders(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: Post[] = await response.json();
      const latestNonFeatured = data.filter((post) => !post.sticky).slice(0, 5);
      setPosts(latestNonFeatured);
    } catch (error) {
      Alert.alert('Error', 'Failed to fetch posts');
    } finally {
      setLoading(false);
    }
  };

  const stripHtml = (html: string): string =>
    html ? html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim() : '';

  const trimToWords = (text: string, maxWords: number): string => {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      return text;
    }

    return `${words.slice(0, maxWords).join(' ')}...`;
  };

  const getFeaturedImage = (post: Post): string | null =>
    post._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null;

  const renderPost = ({ item }: { item: Post }) => (
    <Card style={styles.card}>
      {getFeaturedImage(item) ? (
        <Card.Cover source={{ uri: getFeaturedImage(item) as string }} style={styles.postImage} />
      ) : (
        <View style={styles.imagePlaceholder}>
          <Text style={styles.imagePlaceholderText}>No image</Text>
        </View>
      )}
      <Card.Content>
        <Title style={styles.postTitle}>{stripHtml(item.title.rendered)}</Title>
        <Paragraph style={styles.postExcerpt}>{trimToWords(stripHtml(item.excerpt.rendered), 30)}</Paragraph>
        <Button
          mode="contained"
          style={styles.readMoreButton}
          onPress={() => navigation.navigate('PostDetails', { post: item })}
        >
          Read More
        </Button>
      </Card.Content>
    </Card>
  );

  if (loading) {
    return (
      <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator animating size={52} color="#ffffff" />
          <Text style={styles.loadingText}>Loading latest news</Text>
        </View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
      <FlatList
        data={posts}
        renderItem={renderPost}
        keyExtractor={(item) => item.id.toString()}
        style={styles.list}
      />
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 14 },
  list: { flex: 1 },
  card: { margin: 10 },
  postImage: { height: 180 },
  imagePlaceholder: { height: 180, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ddd' },
  imagePlaceholderText: { fontSize: 13, color: '#666' },
  postTitle: { fontSize: 15, fontWeight: 'bold' },
  postExcerpt: { fontSize: 13, color: '#444', marginTop: 4 },
  readMoreButton: { marginTop: 10, alignSelf: 'flex-start' },
});

export default PostsScreen;
